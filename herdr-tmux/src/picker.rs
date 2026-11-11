//! Keyboard selection and bounded terminal rendering shared by popup pickers.

use std::io::{self, Write};
use std::time::{Duration, Instant};

use crossterm::cursor::{Hide, MoveTo, Show};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::style::{
    Attribute, Color, ResetColor, SetAttribute, SetForegroundColor,
};
use crossterm::terminal::{
    self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen,
};
use crossterm::{execute, queue};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Row {
    pub identity: String,
    pub cells: [String; 5],
    pub status: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Choice {
    Select(usize),
    Cancel,
}

#[derive(Debug, Default)]
pub(crate) struct State {
    pub selected: usize,
    pub offset: usize,
    pub query: String,
    pub searching: bool,
}

impl State {
    pub fn handle(&mut self, event: Event, count: usize) -> Option<Choice> {
        let Event::Key(key) = event else { return None };
        if key.kind != KeyEventKind::Press {
            return None;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && key.code == KeyCode::Char('c')
        {
            return Some(Choice::Cancel);
        }
        if self.searching {
            let changed = match key.code {
                KeyCode::Esc | KeyCode::Enter => {
                    self.searching = false;
                    false
                }
                KeyCode::Backspace => self.query.pop().is_some(),
                KeyCode::Char(character)
                    if !key.modifiers.intersects(
                        KeyModifiers::CONTROL | KeyModifiers::ALT,
                    ) =>
                {
                    self.query.push(character);
                    true
                }
                _ => false,
            };
            if changed {
                self.selected = 0;
                self.offset = 0;
            }
            return None;
        }
        if !key.modifiers.is_empty() {
            return None;
        }
        match key.code {
            KeyCode::Char('/') => self.searching = true,
            KeyCode::Esc => return Some(Choice::Cancel),
            KeyCode::Enter if count > 0 => {
                return Some(Choice::Select(self.selected.min(count - 1)))
            }
            KeyCode::Char(digit) if digit.is_ascii_digit() => {
                let index = digit as usize - '0' as usize;
                if index < count {
                    return Some(Choice::Select(index));
                }
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(count.saturating_sub(1));
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
            }
            _ => {}
        }
        None
    }

    pub fn matches(&self, rows: &[Row]) -> Vec<usize> {
        let query = self.query.to_lowercase();
        rows.iter()
            .enumerate()
            .filter_map(|(index, row)| {
                (query.is_empty()
                    || row.cells[1..]
                        .iter()
                        .any(|cell| cell.to_lowercase().contains(&query)))
                .then_some(index)
            })
            .collect()
    }

    pub fn replace_rows(&mut self, previous: &[Row], updated: &[Row]) {
        let selected = self
            .matches(previous)
            .get(self.selected)
            .map(|index| &previous[*index].identity);
        let matches = self.matches(updated);
        self.selected = selected
            .and_then(|identity| {
                matches
                    .iter()
                    .position(|index| &updated[*index].identity == identity)
            })
            .unwrap_or(self.selected.min(matches.len().saturating_sub(1)));
    }

    pub fn scroll(&mut self, count: usize, height: usize) {
        self.selected = self.selected.min(count.saturating_sub(1));
        self.offset = self.offset.min(count.saturating_sub(height));
        if self.selected < self.offset {
            self.offset = self.selected;
        } else if self.selected >= self.offset + height {
            self.offset = self.selected.saturating_sub(height.saturating_sub(1));
        }
    }
}

// A popup owns its terminal screen. Restore both screen and cursor even when
// reading an event or writing a frame fails.
struct Terminal;

impl Terminal {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        let guard = Self;
        execute!(io::stdout(), EnterAlternateScreen, Hide)?;
        Ok(guard)
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = execute!(
            io::stdout(),
            SetAttribute(Attribute::Reset),
            ResetColor,
            Show,
            LeaveAlternateScreen
        );
        let _ = terminal::disable_raw_mode();
    }
}

pub(crate) fn run<F>(
    mut rows: Vec<Row>,
    headings: [&str; 5],
    mut refresh: F,
) -> io::Result<Choice>
where
    F: FnMut() -> io::Result<Vec<Row>>,
{
    let _terminal = Terminal::enter()?;
    let mut state = State {
        selected: rows.iter().position(|row| row.focused).unwrap_or(0),
        ..State::default()
    };
    let mut refreshed_at = Instant::now();
    loop {
        if refreshed_at.elapsed() >= Duration::from_secs(1) {
            let updated = refresh()?;
            state.replace_rows(&rows, &updated);
            rows = updated;
            refreshed_at = Instant::now();
        }
        let (width, height) = terminal::size()?;
        let matches = state.matches(&rows);
        let filtered = matched_rows(&rows, &matches);
        render(
            &mut io::stdout().lock(),
            &filtered,
            headings,
            &mut state,
            width,
            height,
        )?;
        if !event::poll(
            Duration::from_secs(1).saturating_sub(refreshed_at.elapsed()),
        )? {
            continue;
        }
        let selectable = if width == 0 || height == 0 {
            0
        } else {
            matches.len()
        };
        if let Some(choice) = state.handle(event::read()?, selectable) {
            return Ok(match choice {
                Choice::Select(index) => Choice::Select(matches[index]),
                Choice::Cancel => Choice::Cancel,
            });
        }
    }
}

fn matched_rows(rows: &[Row], matches: &[usize]) -> Vec<Row> {
    matches
        .iter()
        .enumerate()
        .map(|(shortcut, index)| {
            let mut row = rows[*index].clone();
            row.cells[0] = format!(
                "{} {}",
                if shortcut < 10 {
                    shortcut.to_string()
                } else {
                    " ".into()
                },
                if row.focused { "*" } else { " " }
            );
            row
        })
        .collect()
}

pub(crate) fn render<W: Write>(
    writer: &mut W,
    rows: &[Row],
    headings: [&str; 5],
    state: &mut State,
    width: u16,
    height: u16,
) -> io::Result<()> {
    queue!(writer, MoveTo(0, 0), Clear(ClearType::All))?;
    if width == 0 || height == 0 {
        return writer.flush();
    }
    let width = usize::from(width);
    if height <= 3 {
        state.scroll(rows.len(), 1);
        let range_width = if height == 1 {
            width.saturating_sub(width.min(12))
        } else {
            width
        };
        let range = row_range(state.offset, 1, rows.len(), range_width);
        let title = rows
            .get(state.selected)
            .map(|row| {
                format!("{} {} {}", row.cells[0], row.cells[4], row.cells[2])
            })
            .unwrap_or_else(|| "No matches".into());
        queue!(writer, SetAttribute(Attribute::Reverse))?;
        if height == 1 {
            write_split_line(writer, &title, &range, width)?;
        } else {
            write!(writer, "{}", clip(&title, width))?;
            queue!(writer, SetAttribute(Attribute::Reset), MoveTo(0, 1))?;
            write_split_line(writer, "", &range, width)?;
            if height == 3 {
                queue!(writer, MoveTo(0, 2))?;
                write!(
                    writer,
                    "{}",
                    clip("j/k move · enter open · esc close", width)
                )?;
            }
        }
        queue!(writer, SetAttribute(Attribute::Reset), ResetColor)?;
        return writer.flush();
    }

    let separator = height >= 6;
    let header_y = if separator { 2 } else { 1 };
    let body_y = header_y + 1;
    let body_height = usize::from(height - body_y - 1);
    state.scroll(rows.len(), body_height);
    let range = row_range(state.offset, body_height, rows.len(), width);
    let query = format!(
        "/ {}{}",
        if state.query.is_empty() && !state.searching {
            "search".to_owned()
        } else {
            state.query.clone()
        },
        if state.searching { "▏" } else { "" }
    );
    queue!(writer, SetForegroundColor(Color::DarkGrey))?;
    write_split_line(writer, &query, &range, width)?;
    if separator {
        queue!(writer, MoveTo(0, 1), SetForegroundColor(Color::DarkGrey))?;
        write!(writer, "{}", "─".repeat(width))?;
        queue!(writer, ResetColor)?;
    }
    let widths = column_widths(rows, headings, width);
    queue!(writer, MoveTo(0, header_y))?;
    write_line(
        writer,
        &headings.map(str::to_owned),
        widths,
        width,
        true,
        false,
        "",
    )?;
    for (index, row) in
        rows.iter().enumerate().skip(state.offset).take(body_height)
    {
        queue!(writer, MoveTo(0, body_y + (index - state.offset) as u16))?;
        write_line(
            writer,
            &row.cells,
            widths,
            width,
            false,
            index == state.selected,
            &row.status,
        )?;
    }
    if rows.is_empty() && body_height > 0 {
        queue!(writer, MoveTo(0, body_y))?;
        write!(writer, "{}", clip("No matches", width))?;
    }
    queue!(
        writer,
        MoveTo(0, height - 1),
        SetForegroundColor(Color::DarkGrey)
    )?;
    write!(
        writer,
        "{}",
        clip(
            if state.searching {
                "type to search · enter/esc navigate"
            } else {
                "↑↓/j/k rows · / search · 0-9 jump · enter open · esc close"
            },
            width
        )
    )?;
    queue!(writer, ResetColor)?;
    writer.flush()
}

/// Reserve range metadata before clipping the query so overflow stays visible.
fn write_split_line<W: Write>(
    writer: &mut W,
    left: &str,
    right: &str,
    width: usize,
) -> io::Result<()> {
    let right_width = right.width().min(width);
    let left_width = width.saturating_sub(
        right_width + usize::from(right_width > 0 && right_width < width),
    );
    let fitted = clip(left, left_width);
    write!(
        writer,
        "{fitted}{}",
        " ".repeat(width - right_width - fitted.width())
    )?;
    queue!(
        writer,
        SetAttribute(Attribute::Reset),
        SetForegroundColor(Color::Cyan)
    )?;
    write!(writer, "{right}")?;
    queue!(writer, ResetColor)?;
    Ok(())
}

fn row_range(
    offset: usize,
    visible: usize,
    count: usize,
    width: usize,
) -> String {
    if count == 0 {
        return clip("0/0", width);
    }
    let start = offset + 1;
    let end = (offset + visible).min(count);
    let above = if offset > 0 { "↑" } else { "" };
    let below = if end < count { "↓" } else { "" };
    let range = format!("{above}{start}-{end}/{count}{below}");
    if range.width() <= width {
        range
    } else {
        clip(&format!("{above}{start}/{count}{below}"), width)
    }
}

/// Drop location and harness columns before sacrificing the destination title.
fn column_widths(rows: &[Row], headings: [&str; 5], width: usize) -> [usize; 4] {
    let mut widths: [usize; 4] = std::array::from_fn(|column| {
        rows.iter()
            .map(|row| row.cells[column].width())
            .chain([headings[column].width()])
            .max()
            .unwrap_or(0)
    });
    if width < 12 {
        widths[0] = if width < 6 { 0 } else { 3 };
    }
    let title_width = 16.min(width.saturating_sub(5));
    for column in [3, 1, 2] {
        let metadata_width: usize = widths
            .iter()
            .filter(|size| **size > 0)
            .map(|size| size + 2)
            .sum();
        if metadata_width + title_width <= width {
            break;
        }
        widths[column] = 0;
    }
    widths
}

fn write_line<W: Write>(
    writer: &mut W,
    cells: &[String; 5],
    widths: [usize; 4],
    width: usize,
    heading: bool,
    selected: bool,
    status: &str,
) -> io::Result<()> {
    let mut remaining = width;
    for (column, cell) in cells.iter().enumerate() {
        if column < 4 && widths[column] == 0 {
            continue;
        }
        let available = if column < 4 {
            widths[column].min(remaining)
        } else {
            remaining
        };
        if heading {
            queue!(writer, SetAttribute(Attribute::Bold))?;
        }
        if selected {
            queue!(writer, SetAttribute(Attribute::Reverse))?;
        }
        if !heading && (column == 0 || column == 2) {
            let color = match status {
                "blocked" => Some(Color::Yellow),
                "working" | "shell" => None,
                _ => Some(Color::Cyan),
            };
            if let Some(color) = color {
                queue!(writer, SetForegroundColor(color))?;
            }
            if column == 2 || status != "working" {
                queue!(writer, SetAttribute(Attribute::Bold))?;
            }
        }
        let fitted = clip(cell, available);
        write!(writer, "{fitted}")?;
        remaining -= fitted.width();
        let padding = if column < 4 {
            (available - fitted.width() + 2).min(remaining)
        } else {
            remaining
        };
        write!(writer, "{}", " ".repeat(padding))?;
        remaining -= padding;
        queue!(writer, SetAttribute(Attribute::Reset), ResetColor)?;
    }
    Ok(())
}

pub(crate) fn clip(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let mut result = String::new();
    let mut used = 0;
    for character in text.chars() {
        let cells = character.width().unwrap_or(0);
        if used + cells >= width {
            break;
        }
        result.push(character);
        used += cells;
    }
    result.push('…');
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn navigates_beyond_digits_and_keeps_selection_visible() {
        let mut state = State::default();
        for _ in 0..14 {
            assert_eq!(state.handle(key(KeyCode::Char('j')), 15), None);
        }
        state.scroll(15, 3);
        assert_eq!((state.selected, state.offset), (14, 12));
        assert_eq!(
            state.handle(key(KeyCode::Enter), 15),
            Some(Choice::Select(14))
        );
        assert_eq!(
            state.handle(key(KeyCode::Char('9')), 15),
            Some(Choice::Select(9))
        );
        state.handle(key(KeyCode::Char('k')), 15);
        state.scroll(15, 0);
        assert_eq!(state.selected, 13);
    }

    #[test]
    fn empty_list_ignores_selection_and_escape_cancels() {
        let mut state = State::default();
        assert_eq!(state.handle(key(KeyCode::Enter), 0), None);
        assert_eq!(state.handle(key(KeyCode::Char('9')), 1), None);
        assert_eq!(state.handle(key(KeyCode::Esc), 0), Some(Choice::Cancel));
    }

    #[test]
    fn clipping_preserves_terminal_cell_width() {
        assert_eq!(clip("你好 world", 4), "你…");
        assert_eq!(clip("abc", 0), "");
        assert_eq!(clip("abc", 3), "abc");
    }

    fn rows() -> Vec<Row> {
        rows_with_count(15)
    }

    fn rows_with_count(count: usize) -> Vec<Row> {
        (0..count)
            .map(|index| Row {
                identity: format!("pane-{index}"),
                cells: [
                    String::new(),
                    "Codex".into(),
                    "idle".into(),
                    "t2_w1".into(),
                    format!("Task {index} 界"),
                ],
                status: "idle".into(),
                focused: false,
            })
            .collect()
    }

    #[test]
    fn tiny_resize_prioritizes_selected_row_over_chrome() {
        let rows = rows();
        let mut state = State {
            selected: 14,
            ..State::default()
        };
        for height in [14, 1, 2, 3, 14] {
            let mut output = Vec::new();
            render(
                &mut output,
                &rows,
                ["Agent", "Harness", "Status", "Tab", "Title"],
                &mut state,
                72,
                height,
            )
            .unwrap();
            assert!(String::from_utf8(output).unwrap().contains("Task 14"));
        }
        assert_eq!(state.selected, 14);
    }

    #[test]
    fn search_digits_are_text_and_navigation_digits_use_filtered_indices() {
        let rows = rows();
        let mut state = State::default();
        state.handle(key(KeyCode::Char('/')), rows.len());
        for character in "TASK 14".chars() {
            assert_eq!(
                state.handle(key(KeyCode::Char(character)), rows.len()),
                None
            );
        }
        assert_eq!(state.matches(&rows), [14]);
        assert_eq!(
            matched_rows(&rows, &state.matches(&rows))[0].cells[0],
            "0  "
        );
        assert_eq!(state.handle(key(KeyCode::Enter), 1), None);
        let Some(Choice::Select(index)) =
            state.handle(key(KeyCode::Char('0')), 1)
        else {
            panic!("expected shortcut")
        };
        assert_eq!(state.matches(&rows)[index], 14);
    }

    #[test]
    fn search_exit_does_not_close_and_backspace_handles_unicode() {
        let mut state = State::default();
        state.handle(key(KeyCode::Char('/')), 0);
        state.handle(key(KeyCode::Char('界')), 0);
        assert_eq!(state.query, "界");
        state.handle(key(KeyCode::Backspace), 0);
        assert!(state.query.is_empty());
        assert_eq!(state.handle(key(KeyCode::Esc), 0), None);
        assert_eq!(state.handle(key(KeyCode::Esc), 0), Some(Choice::Cancel));
    }

    #[test]
    fn search_matches_every_display_field_before_clipping() {
        let rows = rows();
        for query in ["codex", "IDLE", "t2_w1", "界"] {
            let state = State {
                query: query.into(),
                ..State::default()
            };
            assert_eq!(state.matches(&rows).len(), 15);
        }
        let mut state = State {
            query: "missing".into(),
            ..State::default()
        };
        assert!(state.matches(&rows).is_empty());
        let mut output = Vec::new();
        render(
            &mut output,
            &[],
            ["Agent", "Harness", "Status", "Tab", "Title"],
            &mut state,
            72,
            14,
        )
        .unwrap();
        assert!(String::from_utf8(output).unwrap().contains("No matches"));
    }

    #[test]
    fn refresh_keeps_selected_identity_across_insertions_and_removal() {
        let original = rows();
        let mut state = State {
            selected: 12,
            ..State::default()
        };
        let mut updated = original.clone();
        updated.remove(0);
        state.replace_rows(&original, &updated);
        assert_eq!(state.selected, 11);
        assert_eq!(updated[state.selected].identity, original[12].identity);
        let previous = updated.clone();
        updated.remove(11);
        state.replace_rows(&previous, &updated);
        assert_eq!(state.selected, 11);
        assert_eq!(updated[state.selected].identity, original[13].identity);
        state.replace_rows(&updated, &[]);
        assert_eq!(state.selected, 0);
    }

    #[test]
    fn renderer_fits_unicode_rows_after_resize() {
        let rows = rows();
        for width in [0, 1, 8, 32, 72] {
            for height in [0, 1, 2, 3, 4, 14] {
                let mut output = Vec::new();
                render(
                    &mut output,
                    &rows,
                    ["Agent", "Harness", "Status", "Tab", "Title"],
                    &mut State::default(),
                    width,
                    height,
                )
                .unwrap();
                assert!(String::from_utf8(output).is_ok());
            }
        }
    }

    fn render_frame(
        rows: &[Row],
        state: &mut State,
        width: u16,
        height: u16,
    ) -> String {
        let mut output = Vec::new();
        render(
            &mut output,
            rows,
            ["Agent", "Harness", "Status", "Tab", "Title"],
            state,
            width,
            height,
        )
        .unwrap();
        String::from_utf8(output).unwrap()
    }

    #[test]
    fn large_popup_shows_every_agent_in_a_fourteen_row_session() {
        let rows = rows_with_count(14);
        let frame = render_frame(
            &matched_rows(&rows, &State::default().matches(&rows)),
            &mut State::default(),
            116,
            42,
        );
        for index in 0..14 {
            assert!(frame.contains(&format!("Task {index} 界")));
        }
        assert!(frame.contains("1-14/14\x1b"));
    }

    #[test]
    fn overflow_ranges_identify_hidden_rows_at_top_middle_and_end() {
        let rows = rows_with_count(50);
        let mut state = State::default();
        for (selected, expected) in
            [(0, "1-6/50↓"), (25, "↑21-26/50↓"), (49, "↑45-50/50")]
        {
            state.selected = selected;
            let frame = render_frame(&rows, &mut state, 72, 10);
            assert!(frame.contains(expected), "missing {expected}");
            assert!(frame.contains(&format!("Task {selected} 界")));
        }
    }

    #[test]
    fn long_query_cannot_displace_the_range_or_overflow_cue() {
        let rows = rows_with_count(50);
        let mut state = State {
            query: "界very-long-query".repeat(20),
            searching: true,
            ..State::default()
        };
        let frame = render_frame(&rows, &mut state, 24, 10);
        assert!(frame.contains("1-6/50↓"));
        assert!(!frame.contains(&state.query));
    }

    #[test]
    fn constrained_resize_preserves_selected_title_and_row_range() {
        let rows = rows_with_count(60);
        let mut state = State {
            selected: 45,
            ..State::default()
        };
        for (width, height) in [(116, 42), (32, 9), (32, 2), (32, 1), (116, 42)]
        {
            let frame = render_frame(&rows, &mut state, width, height);
            assert!(
                frame.contains("Task 45 界"),
                "selected title missing at {width}x{height}"
            );
            assert!(
                frame.contains("/60"),
                "row range missing at {width}x{height}"
            );
        }
    }

    #[test]
    fn searching_after_scroll_resets_viewport_and_keeps_result_shortcuts() {
        let rows = rows_with_count(50);
        let mut state = State {
            selected: 49,
            ..State::default()
        };
        render_frame(&rows, &mut state, 72, 10);
        assert_eq!(state.offset, 44);
        state.handle(key(KeyCode::Char('/')), 50);
        for character in "Task 4".chars() {
            state.handle(key(KeyCode::Char(character)), 50);
        }
        assert_eq!((state.selected, state.offset), (0, 0));
        let matches = state.matches(&rows);
        let filtered = matched_rows(&rows, &matches);
        assert_eq!(matches.len(), 11);
        assert_eq!(filtered[9].cells[0], "9  ");
        assert_eq!(filtered[10].cells[0], "   ");
        state.handle(key(KeyCode::Enter), matches.len());
        assert_eq!(
            state.handle(key(KeyCode::Char('9')), matches.len()),
            Some(Choice::Select(9))
        );
        assert_eq!(matches[9], 48);
        state.selected = 10;
        let frame = render_frame(&filtered, &mut state, 72, 10);
        assert!(frame.contains("↑6-11/11"));
        assert_eq!(filtered[9].cells[0], "9  ");
    }

    #[test]
    #[ignore = "manual ANSI captures of the production picker renderer"]
    fn capture_picker_geometry_frames() {
        let directory =
            std::env::temp_dir().join("herdr-navigation/geometry-captures");
        std::fs::create_dir_all(&directory).unwrap();
        for (name, count, selected, width, height, query) in [
            ("large-fourteen", 14, 6, 116, 42, ""),
            ("overflow-top", 50, 0, 72, 10, ""),
            ("overflow-middle", 50, 25, 72, 10, ""),
            ("overflow-end", 50, 49, 72, 10, ""),
            (
                "narrow-long-query",
                50,
                25,
                32,
                10,
                "界very-long-query-containing-lots-of-text",
            ),
        ] {
            let mut rows = rows_with_count(count);
            if !query.is_empty() {
                for row in &mut rows {
                    row.cells[4].push_str(&format!(" {query}"));
                }
            }
            let mut state = State {
                selected,
                query: query.into(),
                ..State::default()
            };
            let frame = render_frame(
                &matched_rows(&rows, &(0..count).collect::<Vec<_>>()),
                &mut state,
                width,
                height,
            );
            std::fs::write(directory.join(format!("{name}.ansi")), frame)
                .unwrap();
        }
        eprintln!("ANSI captures: {}", directory.display());
    }

    #[test]
    #[ignore = "manual render and filter scaling measurement"]
    fn picker_render_scale_profile() {
        let headings = ["Agent", "Harness", "Status", "Tab", "Title"];
        for count in [1, 15, 52, 512] {
            let rows: Vec<_> = (0..count)
                .map(|index| {
                    let mut row = rows()[0].clone();
                    row.identity = index.to_string();
                    row.cells[4] = format!("Task {index}");
                    row
                })
                .collect();
            for query in ["", "Task 1"] {
                let mut state = State {
                    query: query.into(),
                    ..State::default()
                };
                let start = Instant::now();
                for _ in 0..200 {
                    let matches = state.matches(&rows);
                    let filtered = matched_rows(&rows, &matches);
                    render(
                        &mut io::sink(),
                        &filtered,
                        headings,
                        &mut state,
                        100,
                        30,
                    )
                    .unwrap();
                }
                eprintln!(
                    "plugin rows={count} query={query:?} filter+render_us={:.2}",
                    start.elapsed().as_secs_f64() * 1_000_000.0 / 200.0
                );
            }
        }
    }
}
