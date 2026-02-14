# Marp Cheatsheet & Theme Guide

## Basic Syntax

### Slide Separator

Use `---` to separate slides.

```markdown
# Slide 1

Content...

---

# Slide 2

Content...
```

### Directives

Place at the top of the file.

```yaml
---
marp: true
theme: business
paginate: true
size: 16:9
---
```

## Layouts (Custom Classes)

Classes are defined in the theme CSS (`assets/themes/*.css`). Use `<!-- _class: name -->` for a single slide or `<!-- class: name -->` for all following slides.

### Business Theme (`theme: business`)

| Class     | Description                                         |
| :-------- | :-------------------------------------------------- |
| `title`   | Title slide with centered text and blue background. |
| (default) | Standard content slide with header/footer support.  |

**Example:**

```markdown
<!-- _class: title -->

# Presentation Title

## Subtitle
```

### 2-Column Layout

Use HTML to create columns.

```html
<div class="columns">
  <div>Left content</div>
  <div>Right content</div>
</div>
```

## Images

Resize images:
`![width:200px](image.png)`
`![height:300px](image.png)`

Background images:
`![bg](background.jpg)`
`![bg right:40%](side-image.jpg)`
