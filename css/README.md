# CSS Assets

## `github-markdown.min.css`

Downloaded from Cloudflare cdnjs for local Pandoc/Markdown previews.

- Package: `github-markdown-css`
- Version: `5.8.1`
- Source URL: `https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown.min.css`
- Local path: `$DOTFILES/css/github-markdown.min.css`

## `github-markdown-pandoc.css`

Small local override for Pandoc-generated HTML. The upstream
`github-markdown-css` package expects rendered Markdown to live inside
`.markdown-body`, but it does not set the GitHub-like page width/padding by
itself.

- Local path: `$DOTFILES/css/github-markdown-pandoc.css`
- Adds GitHub's typical `max-width: 980px`, centered layout, and `45px` page
  padding for `.markdown-body`.

Example usage:

```bash
GH_MD_CSS="$DOTFILES/css/github-markdown.min.css"
GH_PANDOC_CSS="$DOTFILES/css/github-markdown-pandoc.css"
auto-pandoc calc-liq.md -s --katex --css="$GH_MD_CSS" --css="$GH_PANDOC_CSS" -o index.html
```
