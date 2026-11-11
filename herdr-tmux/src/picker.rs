//! Keyboard selection and bounded terminal rendering shared by popup pickers.

use std::io::{self, Write};

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

#[derive(Debug, Clone)]
pub(crate) struct Row {
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
        if !key.modifiers.is_empty() {
            return None;
        }
        match key.code {
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

pub(crate) fn run(rows: &[Row], headings: [&str; 5]) -> io::Result<Choice> {
    let _terminal = Terminal::enter()?;
    let mut state = State {
        selected: rows.iter().position(|row| row.focused).unwrap_or(0),
        ..State::default()
    };
    loop {
        let (width, height) = terminal::size()?;
        render(
            &mut io::stdout().lock(),
            rows,
            headings,
            &mut state,
            width,
            height,
        )?;
        if let Some(choice) = state.handle(event::read()?, rows.len()) {
            return Ok(choice);
        }
    }
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
    let body_height = usize::from(height.saturating_sub(2));
    state.scroll(rows.len(), body_height);
    let widths: [usize; 4] = std::array::from_fn(|column| {
        rows.iter()
            .map(|row| row.cells[column].width())
            .chain([headings[column].width()])
            .max()
            .unwrap_or(0)
    });
    write_line(
        writer,
        &headings.map(str::to_owned),
        widths,
        usize::from(width),
        true,
        false,
        "",
    )?;
    for (index, row) in
        rows.iter().enumerate().skip(state.offset).take(body_height)
    {
        queue!(writer, MoveTo(0, (index - state.offset + 1) as u16))?;
        write_line(
            writer,
            &row.cells,
            widths,
            usize::from(width),
            false,
            index == state.selected,
            &row.status,
        )?;
    }
    if height > 1 {
        queue!(writer, MoveTo(0, height - 1))?;
        write!(
            writer,
            "{}",
            clip(
                "0-9 jump · j/k move · enter open · esc close",
                usize::from(width)
            )
        )?;
    }
    writer.flush()
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
}
