import type { Element as HastElement } from 'hast';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import {
  ProjectMetaSchema,
  VolumeMetaSchema,
  type ProjectMetaSchemaType,
  type VolumeFrontmatterType,
} from './utils/schema';
import {
  extractFrontmatter,
  fromMarkdownToMdast,
  hastToHtml,
  mdastToHast,
  prettifyHtml,
  prettifyXml,
  splitContentAtImage,
} from './utils/markdown';
import { Epub, type DcCreator } from '@smoores/epub';
import {
  autogenColophon,
  autogenAuthorSign,
  autogenCover,
  autogenFootnotes,
  autogenNcxFile,
  autogenToC,
  generateXHash,
  type MetaToC,
} from './utils/autogen';

const baseDir = fileURLToPath(dirname(import.meta.url));
const sourcesFolders = join(baseDir, 'sources');
const imagesFolder = join(baseDir, '_Images');

// Create _Final folder if it doesn't exist
const finalFolder = join(baseDir, '_Final');
if (!(await exists(finalFolder))) {
  await mkdir(finalFolder);
}

function makeFileName(meta: ProjectMetaSchemaType, volumeNumber: number) {
  const paddedNumber = String(volumeNumber).padStart(2, '0');
  return `${meta.title} v${paddedNumber} [${meta.publisher.name}] [${meta.translator.name}] [${meta.compiler.name}].epub`;
}

function coerceAuthorFileAs(originalName: string) {
  // Split by spaces
  const parts = originalName.split(' ');
  if (parts.length < 2) {
    return originalName.toUpperCase();
  }

  // Get the first part and put it as last
  const firstPart = parts.shift();
  if (!firstPart) {
    return originalName.toUpperCase();
  }

  // Join the rest of the parts
  const rest = parts.join(' ').toUpperCase();
  return `${rest}, ${firstPart.toUpperCase()}`;
}

function metaRoleToEpubRole(role: ProjectMetaSchemaType['teams'][number]['role']) {
  switch (role) {
    case 'translator':
      return 'trl';
    case 'proofreader':
      return 'pfr';
    case 'editor':
      return 'edt';
    case 'lettering':
      return 'ltr';
    case 'cover':
      return 'cov';
    case 'designer':
      return 'bkd';
    case 'quality-checker':
      return 'rev';
  }
}

async function processVolume(projectMeta: ProjectMetaSchemaType, volumeNumber: string) {
  const volumeFolder = join(sourcesFolders, volumeNumber);
  if (!(await exists(volumeFolder))) {
    throw new Error(`Volume folder does not exist: ${volumeFolder}`);
  }

  const keepFile = join(volumeFolder, '.keep');
  if (await exists(keepFile)) {
    // .keep file means that this is placeholder for future volumes
    console.log(`Skipping volume ${volumeNumber} as it is a placeholder`);
    return;
  }

  const metaJson = join(volumeFolder, 'meta.json');
  if (!(await exists(metaJson))) {
    throw new Error(`Meta file does not exist: ${metaJson}`);
  }

  const metaFile = await readFile(metaJson, {
    encoding: 'utf-8',
  });

  const meta = await VolumeMetaSchema.parseAsync(JSON.parse(metaFile));
  console.log(`-- Loading: ${meta.title}`);

  const locale = new Intl.Locale('en-US');
  locale.textInfo = {
    direction: 'ltr',
  };

  const creators: DcCreator[] = [
    {
      name: projectMeta.author.writer,
      fileAs: coerceAuthorFileAs(projectMeta.author.writer),
      role: 'aut',
    },
  ];
  if (projectMeta.author.illustrator) {
    creators.push({
      name: projectMeta.author.illustrator,
      fileAs: coerceAuthorFileAs(projectMeta.author.illustrator),
      role: 'ill',
    });
  }
  creators.push({
    name: projectMeta.translator.name,
    fileAs: coerceAuthorFileAs(projectMeta.translator.name),
    role: 'trl',
  });
  projectMeta.teams.forEach((team) => {
    creators.push({
      name: team.name,
      fileAs: coerceAuthorFileAs(team.name),
      role: metaRoleToEpubRole(team.role),
    });
  });

  const epub = await Epub.create({
    title: meta.title,
    language: locale,
    identifier: meta.identifier,
    creators,
  });
  console.log(`-- Loaded: ${meta.title}`);

  const baseImageFolder = join(imagesFolder, volumeNumber);
  const coverPath = join(baseImageFolder, meta.cover);
  if (!(await exists(coverPath))) {
    throw new Error(`Cover image does not exist: ${coverPath}`);
  }
  await epub.setCoverImage(`Images/${basename(coverPath)}`, await readFile(coverPath));

  // Add styles
  await epub.addManifestItem(
    {
      id: 'style.css',
      href: 'Styles/book.css',
      mediaType: 'text/css',
    },
    await readFile(join(baseDir, 'common', 'styles.css')),
  );

  // Import all images
  const imageFiles = await readdir(baseImageFolder);
  for (const imageFile of imageFiles) {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const extension = extname(imageFile).toLowerCase();
    if (!validExtensions.includes(extension)) {
      continue;
    }

    const imagePath = join(baseImageFolder, imageFile);
    if (imagePath === coverPath) {
      continue;
    }
    const readImage = await readFile(imagePath);
    await epub.addManifestItem(
      {
        id: basename(imagePath),
        href: `Images/${basename(imagePath)}`,
        mediaType: `image/${extension.replace('.', '')}`,
      },
      readImage,
    );
  }

  if (projectMeta.translator.image) {
    const projectMetaImage = join(baseDir, projectMeta.translator.image);
    if (!(await exists(projectMetaImage))) {
      throw new Error(`Translator image does not exist: ${projectMetaImage}`);
    }

    const readImage = await readFile(projectMetaImage);

    const imageFn = basename(projectMetaImage);
    await epub.addManifestItem(
      {
        id: `credit-icon-${imageFn}`,
        href: `Images/credit-icon-${imageFn}`,
        mediaType: `image/${extname(imageFn).replace('.', '')}`,
      },
      readImage,
    );
  }

  const bookSpines: Record<string, MetaToC | MetaToC[]> = {};
  const navContents = [];
  const tocMetaMappings: Record<string, VolumeFrontmatterType> = {};

  let rawFootnotesCounter = 1;
  const tocFootnotesCounter: Record<string, { n: number; fn: string; content: HastElement | null }> = {};
  let tocFileMeta: MetaToC | undefined;
  let navigationFileMeta: MetaToC | undefined;
  let footnotesFileMeta: MetaToC | undefined;

  for (const toc of meta.toc) {
    const tocFile = join(volumeFolder, toc.filename);
    if (!(await exists(tocFile))) {
      throw new Error(`ToC file does not exist: ${tocFile}`);
    }

    const tocContent = await readFile(tocFile, {
      encoding: 'utf-8',
    });

    const footNotesReferences = (label: string, filename: string) => {
      const current = rawFootnotesCounter;
      if (tocFootnotesCounter[label]) {
        return { n: tocFootnotesCounter[label].n, fn: tocFootnotesCounter[label].fn };
      }

      rawFootnotesCounter++;
      tocFootnotesCounter[label] = {
        n: current,
        fn: filename,
        content: null,
      };
      return {
        n: current,
        fn: filename,
      };
    };

    const footNotesDefinition = (label: string, hastNode: HastElement) => {
      if (tocFootnotesCounter[label]) {
        tocFootnotesCounter[label].content = hastNode;
      }
    };

    // Process the ToC content here
    console.log(` --]> Processing ToC: ${toc.title}`);
    const compiled = extractFrontmatter(tocContent);
    tocMetaMappings[toc.filename] = compiled.meta;
    const markdownParsed = fromMarkdownToMdast(compiled.content);
    const newFilename = toc.filename.replace(/\.md$/, '.xhtml');

    switch (compiled.meta.template) {
      case 'cover': {
        const coverFile = await prettifyHtml(autogenCover(meta));
        await epub.addManifestItem(
          {
            id: 'cover.xhtml',
            href: `Text/${newFilename}`,
            mediaType: 'application/xhtml+xml',
          },
          coverFile,
          'utf-8',
        );
        bookSpines[toc.filename] = {
          filename: `cover.xhtml`,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'toc-simple': {
        tocFileMeta = {
          filename: newFilename,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'footnotes': {
        footnotesFileMeta = {
          filename: newFilename,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'navigation': {
        if (navigationFileMeta) {
          throw new Error('Navigation file already exists: ' + navigationFileMeta.filename);
        }
        navigationFileMeta = {
          filename: newFilename,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'colophon': {
        const colophonContent = await prettifyHtml(autogenColophon(projectMeta, meta));
        await epub.addManifestItem(
          {
            id: newFilename,
            href: `Text/${newFilename}`,
            mediaType: 'application/xhtml+xml',
          },
          colophonContent,
          'utf-8',
        );
        bookSpines[toc.filename] = {
          filename: newFilename,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'afterword': {
        const afterwordFile = mdastToHast(
          markdownParsed,
          newFilename,
          footNotesReferences,
          footNotesDefinition,
        );
        // Append new thing to the end of the file
        if (afterwordFile.type === 'root') {
          afterwordFile.children.push(autogenAuthorSign(projectMeta.author.writer));
        }
        const html = await prettifyHtml(hastToHtml(afterwordFile, newFilename, 'chapter', toc, meta));

        await epub.addManifestItem(
          {
            id: newFilename,
            href: `Text/${newFilename}`,
            mediaType: 'application/xhtml+xml',
          },
          html,
          'utf-8',
        );
        bookSpines[toc.filename] = {
          filename: newFilename,
          title: toc.title,
          type: toc.type,
          landmark: toc.landmark,
          break: toc.break,
        };
        break;
      }
      case 'chapter':
      case 'images': {
        const splitByImages = splitContentAtImage(markdownParsed);

        for (let i = 0; i < splitByImages.length; i++) {
          const split = splitByImages[i]!;
          let justName = newFilename.replace(/\.xhtml$/, '');
          if (splitByImages.length > 1) {
            justName =
              toc.numbering === 'padzero'
                ? `${justName}${String(i + 1).padStart(2, '0')}`
                : `${justName}_${i + 1}`;
          }

          if (i === 0 && compiled.meta.toc) {
            navContents.push({
              title: toc.title,
              filename: `${justName}.xhtml`,
              type: toc.type,
            });
          }

          const extracted = mdastToHast(split, justName, footNotesReferences, footNotesDefinition);
          const html = await prettifyHtml(
            hastToHtml(extracted, justName, split.fullImage ? 'insert' : 'chapter', toc, meta),
          );

          await epub.addManifestItem(
            {
              id: `${justName}.xhtml`,
              href: `Text/${justName}.xhtml`,
              mediaType: 'application/xhtml+xml',
            },
            html,
            'utf-8',
          );

          if (splitByImages.length > 1) {
            if (!bookSpines[toc.filename]) {
              bookSpines[toc.filename] = [];
            }
            // @ts-expect-error
            bookSpines[toc.filename].push({
              filename: `${justName}.xhtml`,
              title: toc.title,
              type: toc.type,
              landmark: toc.landmark,
              break: toc.break,
            });
          } else {
            bookSpines[toc.filename] = {
              filename: `${justName}.xhtml`,
              title: toc.title,
              type: toc.type,
              landmark: toc.landmark,
              break: toc.break,
            };
          }
        }
        break;
      }
      default: {
        if (compiled.meta.template) {
          console.warn(`Unknown template type: ${compiled.meta.template}`);
          break;
        }
      }
    }
  }

  // Generate simple ToC
  if (tocFileMeta) {
    console.log(` --]> Generating ToC: ${tocFileMeta.title}`);
    const navFile = await prettifyHtml(autogenToC(meta, navContents, 'Contents'));
    await epub.addManifestItem(
      {
        id: tocFileMeta.filename,
        href: `Text/${tocFileMeta.filename}`,
        mediaType: 'application/xhtml+xml',
      },
      navFile,
      'utf-8',
    );
    bookSpines[tocFileMeta.filename] = {
      filename: tocFileMeta.filename,
      title: tocFileMeta.title,
      type: tocFileMeta.type,
      landmark: tocFileMeta.landmark,
      break: tocFileMeta.break,
    };
  }

  // Generate footnotes
  const footnotesItems = Object.values(tocFootnotesCounter)
    .map((item) => item.content)
    .filter((item) => item !== null && item !== undefined) as HastElement[];
  if (footnotesFileMeta && footnotesItems.length > 0) {
    console.log(` --]> Generating footnotes: ${footnotesFileMeta.title}`);
    const footnotesFile = await prettifyHtml(autogenFootnotes(footnotesItems, meta));
    await epub.addManifestItem(
      {
        id: footnotesFileMeta.filename,
        href: `Text/${footnotesFileMeta.filename}`,
        mediaType: 'application/xhtml+xml',
      },
      footnotesFile,
      'utf-8',
    );
    bookSpines[footnotesFileMeta.filename] = {
      filename: footnotesFileMeta.filename,
      title: footnotesFileMeta.title,
      type: footnotesFileMeta.type,
      landmark: footnotesFileMeta.landmark,
      break: footnotesFileMeta.break,
    };
  }

  // Generate navigation file if requested the custom ones
  if (navigationFileMeta) {
    console.log(` --]> Generating navigation file: ${navigationFileMeta.title}`);
    const navFile = await prettifyHtml(autogenToC(meta, navContents, navigationFileMeta.title));
    await epub.addManifestItem(
      {
        id: navigationFileMeta.filename,
        href: `Text/${navigationFileMeta.filename}`,
        mediaType: 'application/xhtml+xml',
      },
      navFile,
      'utf-8',
    );
    bookSpines[navigationFileMeta.filename] = {
      filename: navigationFileMeta.filename,
      title: navigationFileMeta.title,
      type: navigationFileMeta.type,
      landmark: navigationFileMeta.landmark,
      break: navigationFileMeta.break,
    };
  }

  const navChildrenBase: MetaToC[] = [];
  const fullSpines: MetaToC[] = [];
  for (const toc of meta.toc) {
    // Redo for spines and other files
    const metaFrame = tocMetaMappings[toc.filename];
    if (!metaFrame) {
      throw new Error(`Meta not found for ToC: ${toc.filename}`);
    }

    const xhtmlRepl = toc.filename.replace(/\.md$/, '.xhtml');
    const spineItem = bookSpines[toc.filename] ?? bookSpines[xhtmlRepl];
    if (!spineItem) {
      if (toc.optional) {
        continue;
      }
      throw new Error(`ToC not found in book spines: ${toc.filename}`);
    }
    if (Array.isArray(spineItem) && spineItem.length > 0) {
      navChildrenBase.push(spineItem[0]!);
      fullSpines.push(...spineItem);
    } else if (!Array.isArray(spineItem)) {
      navChildrenBase.push(spineItem);
      fullSpines.push(spineItem);
    }
  }

  console.log(` --]> Generating full table of contents: ${meta.title}`);
  const fullNav = await prettifyHtml(autogenToC(meta, navChildrenBase, 'Table of Contents'));
  if (!navigationFileMeta) {
    await epub.addManifestItem(
      {
        id: 'navigation.xhtml',
        href: 'Text/navigation.xhtml',
        mediaType: 'application/xhtml+xml',
        properties: ['nav'],
      },
      fullNav,
      'utf-8',
    );
    fullSpines.push({
      filename: 'navigation.xhtml',
      title: 'Table of Contents',
      type: 'backmatter',
    });
  }

  console.log(` --]> Generating spine items`);
  for (const nav of fullSpines) {
    await epub.addSpineItem(nav.filename);
  }

  // Generate ncx file
  console.log(` --]> Generating NCX file`);
  const ncxContent = prettifyXml(autogenNcxFile(meta, navChildrenBase));
  await epub.addManifestItem(
    {
      id: 'toc.ncx',
      href: 'toc.ncx',
      mediaType: 'application/x-dtbncx+xml',
    },
    ncxContent,
    'utf-8',
  );

  // Add metadata
  console.log(` --]> Adding metadata`);
  await epub.addMetadata({
    type: 'dc:rights',
    value: `Copyright © ${meta.year} ${projectMeta.author.writer}`,
    properties: {},
  });
  await epub.addMetadata({
    type: 'dc:publisher',
    value: 'Foxaholic',
    properties: {},
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      property: 'identifier-type',
      refines: '#pub-id',
      scheme: 'onix:codelist5',
    },
    value: '15',
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      name: 'generator',
      content: 'ln-epub-generator/0.1.0 (+https://github.com/noaione/ln-epub-generator)',
    },
    value: '',
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      refines: '#pub-id',
      property: 'title-type',
    },
    value: 'main',
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      refines: '#pub-id',
      property: 'file-as',
    },
    value: meta.title,
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      name: 'cover',
      content: 'cover-image',
    },
    value: '',
  });
  await epub.addMetadata({
    type: 'meta',
    properties: {
      name: 'x-hash',
      content: generateXHash(),
    },
    value: '',
  });

  console.log(` --]> Unmangling issues with package metadata`);
  // @ts-expect-error - internal stuff
  await epub.withPackageDocument((pkgDoc) => {
    const packageElement = Epub.findXmlChildByName('package', pkgDoc);
    if (!packageElement)
      throw new Error('Failed to parse EPUB: Found no package element in package document');
    const spine = Epub.findXmlChildByName('spine', packageElement['package']);
    if (!spine) throw new Error('Failed to parse EPUB: Found no spine element in package document');
    spine[':@'] = {
      '@_toc': 'toc.ncx',
    };

    // Find the navigation element
    for (const item of spine['spine']) {
      // @ts-expect-error - internal stuff
      if (item[':@']['@_idref'] === 'navigation.xhtml') {
        // @ts-expect-error - internal stuff
        item[':@']['linear'] = 'yes';
      }
    }

    // Add the guide element
    const landmarksItems = Object.values(bookSpines)
      .map((data) => (Array.isArray(data) ? data[0] : data))
      .filter((item) => item?.landmark);
    if (landmarksItems.length > 0) {
      const guide = Epub.createXmlElement(
        'guide',
        {},
        landmarksItems
          .map((item) => {
            if (!item) {
              return null;
            }
            const guideLandmark = item.landmark!.replace('backmatter', 'other.backmatter');
            return Epub.createXmlElement('reference', {
              type: guideLandmark,
              title: item.title,
              href: `Text/${item.filename}`,
            });
          })
          .filter((item) => item !== null),
      );
      packageElement['package'].push(guide);
    }

    const metadataElement = Epub.findXmlChildByName('metadata', packageElement['package']);
    // Add some metadata that got fucked
    metadataElement![':@'] = metadataElement![':@'] ?? {};
    metadataElement![':@']['@_xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    metadataElement![':@']['@_xmlns:opf'] = 'http://www.idpf.org/2007/opf';

    packageElement![':@']!['@_prefix'] = 'rendition: http://www.idpf.org/vocab/rendition/#';
    packageElement![':@']!['@_xmlns'] = 'http://www.idpf.org/2007/opf';

    // Add display-seq for all dc:creator
    const dcCreators = [];
    for (const item of metadataElement!['metadata']) {
      if ('dc:creator' in item) {
        dcCreators.push(item![':@']!['@_id']);
      }
    }
    for (let i = 0; i < dcCreators.length; i++) {
      const id = dcCreators[i];
      // Add display-seq
      metadataElement!['metadata'].push(
        Epub.createXmlElement(
          'meta',
          {
            refines: `#${id}`,
            property: 'display-seq',
          },
          [Epub.createXmlTextNode(`${i + 1}`)],
        ),
      );
    }
  });

  // Write the epub file
  const outputName = makeFileName(projectMeta, meta.volume);
  console.log(` --]> Writing EPUB file: ${outputName}`);
  await epub.writeToFile(join(finalFolder, outputName));
}

// Read meta.json file
const projectMetaFile = join(baseDir, 'meta.json');
if (!(await exists(projectMetaFile))) {
  throw new Error(`Project meta file does not exist: ${projectMetaFile}`);
}
const projectMetaFileContent = await readFile(projectMetaFile, {
  encoding: 'utf-8',
});

console.log('Loading project meta file...');
const projectMeta = await ProjectMetaSchema.parseAsync(JSON.parse(projectMetaFileContent));
console.log('Project meta file loaded:', projectMeta.title);

// Check available volumes
const volumes = await readdir(sourcesFolders);
if (volumes.length === 0) {
  throw new Error('No volumes found in sources folder');
}

volumes.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
console.log(`Found ${volumes.length} volumes: ${volumes.join(', ')}`);
for (const volume of volumes) {
  // Check if is a directory
  const volumePath = join(sourcesFolders, volume);
  if (!(await lstat(volumePath)).isDirectory()) {
    console.warn(`Skipping non-directory: ${volumePath}`);
    continue;
  }

  try {
    await processVolume(projectMeta, volume);
  } catch (error) {
    console.error(`Error processing volume ${volume}:`, error);
  }
}

console.log('All volumes processed successfully!');
