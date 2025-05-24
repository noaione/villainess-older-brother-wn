# I Was Reincarnated As The Older Brother Of A Villainess Destined to Die (WN)

Novelupdates: [Link](https://www.novelupdates.com/series/i-was-reincarnated-as-the-older-brother-of-a-villainess-destined-to-die-so-i-want-to-change-the-future-by-raising-my-younger-sister-with-my-own-hands-i-am-the-strongest-in-the-world-but-my-little-s/)

Right now, I'm only starting from Volume 5 which is translated by [JP Translations for fun](https://wntranslationsforfun.blogspot.com/p/i-was-reincarnated-as-older-brother-of.html)

## Generating the EPUB
### Requirements
- Bun (https://bun.sh/)

### Usage
1. Clone the repository to your local machine.
2. Install the dependencies:
   ```bash
   bun install
   ```
3. Add the images to the `_Images` folder, it should be organized the same as the `sources` folder.
   1. This ebook only use `Cover.jpg` file, you can get the cover from Novelupdates then put it in `_Images/v05/Cover.jpg` as an example.
4. Generate the EPUB file:
   ```bash
   bun run index.ts
   ```
5. The EPUB file will be generated in the `_Final` directory.

## Credits
- Original translation from [JP Translations for fun](https://wntranslationsforfun.blogspot.com/p/i-was-reincarnated-as-older-brother-of.html)
  - **Translator**: Darknight
- **Everything elses**: nao (me)

You can contact me at Discord: `@noaione`<br />
Please send me a message immediately so it go through my Message Request.

## License

None, although the generation code is licensed under the MIT License. See the [LICENSE-CODE](LICENSE-CODE) file for more information.

## Thanks!
- Original translator for the translation.
- [`smoores/epub`](https://www.npmjs.com/package/@smoores/epub) for the EPUB generation tooling
  - The following library has been patched to fix some issues regarding package generation.
- All the used `hast`, `mdast`, `micromark`, `unist` utils.
  - Used the more lower-level libraries to convert the markdown.
  - Also `gray-matter` for the frontmatter extractor.
- [`prettier`](https://prettier.io/) and [`xml-formatter`](https://www.npmjs.com/package/xml-formatter) for the prettier/formatter.
