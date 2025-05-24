# ln-epub-generator

This is a simple template repository for people that want to compile
a fan translation of a light novel into an EPUB file.

## Requirements
- Bun (https://bun.sh/)

## Usage
1. Create a new repository from this template.
2. Clone the repository to your local machine.
3. Install the dependencies:
   ```bash
   bun install
   ```
4. Add your translation files to the `sources` directory.
   - You can see the sampel structure in the `sources` directory.
5. Edit the `meta.json` file to add the metadata for your book.
6. Generate the EPUB file:
   ```bash
   bun run index.ts
   ```
7. The EPUB file will be generated in the `_Final` directory.

## Structure/Schema

You can find more information about the schema of the meta.json in `utils/schema.ts`

This is your project `meta.json` file:
```jsonc
{
    "title": "My EPUB Book", // Required
    "publisher": {
        "name": "Original Publisher", // Required
        "country": "Japan" // Required
    },
    "author": {
        "writer": "Author Name", // Required
        "illustrator": "Illustrator Name" // Optional
    },
    "translator": {
        "name": "Translator Group", // Required
        "url": "https://translator-website.com", // Optional
        "image": null // Optional, this must be relative to the root directory of the project
    },
    "compiler": {
        "name": "Compiler Name", // Required
        "url": "https://github.com/noaione/ln-epub-generator" // Optional
    },
    "teams": [
        // Role can be: translator, proofreader, editor, lettering, designer, quality-checker
        {
            "name": "My Name", // Required
            "role": "translator" // Required
        },
        {
            "name": "Other Name",
            "role": "editor"
        }
    ]
}
```

Then you will see the sources directory structures like this:
```
sources
├── v01
│   ├── cover.md
│   ├── toc.md
│   ├── ... more markdown files
│   └── meta.json
├── v02
│   ├── cover.md
... more files here
```

You would need to conform to the above structure or the generator would fails!

For the `meta.json` file, you can see this schema:
```jsonc
{
    "title": "Project Title: Volume 1", // Required, your book title
    "volume": 1, // Required, volume number
    "identifier": "project-title-v01", // Required, unique identifier for the book
    "cover": "Cover.png", // Required, cover image file name (this will be read from _Images folder)
    "year": 2025, // Required, year of original publication
    "version": "1.0.0", // Required, version of the book
    "toc": [
        {
            "title": "Cover", // Required, title of the section
            "type": "frontmatter", // Required, type of the section (frontmatter, chapter, backmatter)
            "filename": "cover.md" // Required, file name of the section (must be the same as the file name in the sources folder)
        },
        {
            "title": "Contents",
            "type": "frontmatter",
            "filename": "toc.md",
            "landmark": "toc" // Optional, used in nav landmark
        },
        {
            "title": "Prologue",
            "type": "chapter",
            "filename": "chapter0.md",
            "landmark": "bodymatter",
            "break": true // Optional, used to add margin-top for this item
        },
        {
            "title": "Translation Notes",
            "type": "backmatter",
            "filename": "notes.md",
            "optional": true // Optional, if the file is not found (or not auto-generated), it will be ignored
        },
        {
            "title": "Colophon",
            "type": "backmatter",
            "filename": "colophon.md"
        }
    ]
}
```

Each markdown file can have a frontmatter section at the top, like this:
```markdown
---
template: cover
numbering: padzero
toc: false
break: false
---
```

- `template`: the template to use for the file (see below for more info)
- `numbering`: the numbering style to use when splitting the files
- `toc`: whether to include the file in the table of contents (default: `false`)

### Template
The following templates are available:
- `cover`: the cover page, you can leave the content empty and just provide the frontmatter. This will automatically generated from the `meta.json` file.  
- `toc-simple`: a simple table of contents, this will ONLY includes chapters that has `toc` set to `true` in the frontmatter.
- `footnotes`: automatically generate footnotes from all the markdown files.
- `chapter`: a normal chapter, default template.
- `images`: similar to `chapter`, but mainly used for images collage (like illustration pages and such).
- `afterword`: a special template for the afterword. This will add the author name at the end of the page automatically (on the right side).
- `colophon`: a special template that will describe the book and the team that worked on it. This will automatically generated from the `meta.json` file.

Also by default, the following templates are optional:
- `footnotes`
- `toc-simple`

Everything else is required (or need to be defined in the `meta.json` file).

### Numbering
This is used when splitting a single file into multiple files

The following numbering styles are available:
- `padzero`: pad the number with zeroes (e.g. 01, 02, 03)
- `underscore`: use underscores (e.g. _1, _2, _3)

## Markdown

The generator uses the lower-level libraries (`hast`, `mdast`, `micromark`, `unist`) to convert the Markdown to HTML.

We support the CommonMark spec with additional features:
- Footnotes
- Custom thematic break
  We utilize `***`/`---` to automatically generate a custom thematic break.
- Custom image link

### Footnotes

You can add footnotes in your markdown files like this:

```markdown
This is a footnote[^foot1] and this is another one[^foot2].

[^foot1]: This is the first footnote.
[^foot2]: This is the second footnote.
```

You would need to properly define the footnotes ID and make sure they are unique across the entire volume.

The footnotes definitions will then be automatically generated in your provided file that has the `footnotes` template.

### Images

You can add images in your markdown files like this:

```markdown
![Insert Image](../../_Images/v01/Insert01.png)
```

You need to put your images in the `_Images` folder and use the relative path to the image file.
```
_Images
├── v01
│   ├── Cover.png
│   ├── Insert01.png
│   └── Insert02.png
```

See more below for how the images will be generated.

### How splitting works

**Only for chapter and images templates!**

The generator has an automatic splitting feature when an image is found in the middle of the text.
This will not split when the images is inline with the text.

So if you have a file like this:
```markdown
# Chapter 1

blah blah blah

![Insert Image](../../_Images/v01/Insert01.png#.insert)

blah blah blah
```

This will be split into three files:
- `chapter1_1.md`: the first part of the chapter
- `chapter1_2.md`: the `Insert Image` part
- `chapter1_3.md`: the continuation of the chapter

We also support adding a `#` at the end of the image link to add classes to the image.
- `#.insert` will add the `insert` class to the image

You can also NOT split the file by adding `#nosplit` at the end of the image link.

## License

This code is licensed under the MIT License. See the [LICENSE-CODE](LICENSE-CODE) file for more information.

## Thanks!
- [`smoores/epub`](https://www.npmjs.com/package/@smoores/epub) for the EPUB generation tooling
  - The following library has been patched to fix some issues regarding package generation.
- All the used `hast`, `mdast`, `micromark`, `unist` utils.
  - Used the more lower-level libraries to convert the markdown.
  - Also `gray-matter` for the frontmatter extractor.
- [`prettier`](https://prettier.io/) and [`xml-formatter`](https://www.npmjs.com/package/xml-formatter) for the prettier/formatter.
