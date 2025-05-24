import type { Element as HastElement } from 'hast';
import { h } from 'hastscript';
import type { ProjectMetaSchemaType, VolumeMetaSchemaType } from './schema';
import { hastToHtmlRaw } from './markdown';
import crypto from 'node:crypto';
import { basename } from 'node:path';

const templateCover = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" epub:prefix="z3998: http://www.daisy.org/z3998/2012/vocab/structure/#" lang="en" xml:lang="en">

<head>
  <title>Cover</title>
  <link href="../Styles/book.css" rel="stylesheet" type="text/css"/>
</head>

<body class="nomargin center">
  <section epub:type="cover">
    <img alt="Cover" class="cover" src="../Images/{{filename}}"/>
  </section>
</body>

</html>`;

const templateFootnotes = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"
      epub:prefix="z3998: http://www.daisy.org/z3998/2012/vocab/structure/#" lang="en" xml:lang="en">

<head>
  <meta content="text/html; charset=UTF-8" http-equiv="default-style" />
  <title>{{title}}</title>
  <link href="../Styles/book.css" rel="stylesheet" type="text/css" />
</head>

<body>
  <div class="main">
    {{content}}
  </div>
</body>

</html>
`;

const templateSimpleToC = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">

<head>
	<title>{{title}}</title>
	<link href="../Styles/book.css" rel="stylesheet" type="text/css" />
</head>

<body>
	<nav epub:type="toc" id="id" role="doc-toc">
		{{content}}
	</nav>
  {{landmarkContents}}
</body>

</html>
`;

const templateColophon = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"
      epub:prefix="z3998: http://www.daisy.org/z3998/2012/vocab/structure/#" lang="en" xml:lang="en">

<head>
  <meta content="text/html; charset=UTF-8" http-equiv="default-style" />
  <title>{{title}}</title>
  <link href="../Styles/book.css" rel="stylesheet" type="text/css" />
</head>

<body>
  <div class="main">
    {{content}}
  </div>
</body>
`;

const templateNcx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta content="{{identifier}}" name="dtb:uid"/>
    <meta content="1" name="dtb:depth"/>
    <meta content="0" name="dtb:totalPageCount"/>
    <meta content="0" name="dtb:maxPageNumber"/>
  </head>
  <docTitle>
    <text>{{title}}</text>
  </docTitle>
  {{content}}
</ncx>`;

export type MetaToC = {
  title: string;
  filename: string;
  type: string;
  landmark?: string;
  break?: boolean;
};

function roleWithName(role: ProjectMetaSchemaType['teams'][number]['role'], name: string) {
  switch (role) {
    case 'translator':
      return `Translated by ${name}`;
    case 'proofreader':
      return `Proofread by ${name}`;
    case 'editor':
      return `Edited by ${name}`;
    case 'lettering':
      return `Lettered by ${name}`;
    case 'designer':
      return `Designed by ${name}`;
    case 'quality-checker':
      return `Quality checked by ${name}`;
    default:
      return `Unknown role: ${role}`;
  }
}

function getCompilationDate() {
  const date = new Date();
  // this should say May 2025 for example
  const intlDate = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
  }).format(date);
  return intlDate;
}

export function autogenCover(meta: VolumeMetaSchemaType): string {
  return templateCover.replace(/{{filename}}/g, meta.cover);
}

export function autogenToC(
  meta: VolumeMetaSchemaType,
  tocs: MetaToC[],
  title: string = 'Table of Contents',
): string {
  const hNode = h(
    'ol',
    {
      class: 'none',
      'epub:type': 'list',
    },
    tocs.map((item) => {
      let tocClass = `toc-${item.type}`;

      if (item.break) {
        tocClass += ' toc-break';
      }
      return h(
        'li',
        {
          class: tocClass,
        },
        [
          h(
            'a',
            {
              href: `../Text/${item.filename}`,
            },
            [item.title],
          ),
        ],
      );
    }),
  );

  const html = hastToHtmlRaw({
    type: 'root',
    children: [h('h1', { class: 'toc-title' }, [title]), hNode],
  });

  let landmarkContents = '';
  const landmarkItems = tocs.filter((item) => item.landmark);
  if (landmarkItems.length > 0) {
    const landmarkHast = h(
      'nav#landmarks',
      {
        'epub:type': 'landmarks',
        hidden: '1',
      },
      [
        h('h1', {}, ['Landmarks']),
        h(
          'ol',
          {},
          landmarkItems.map((item) => {
            return h('li', {}, [
              h(
                'a',
                {
                  href: `../Text/${item.filename}`,
                  'epub:type': item.landmark!,
                },
                [item.title],
              ),
            ]);
          }),
        ),
      ],
    );
    landmarkContents = hastToHtmlRaw({
      type: 'root',
      children: [landmarkHast],
    });
  }

  return templateSimpleToC
    .replace(/{{title}}/g, meta.title)
    .replace(/{{content}}/g, html)
    .replace(/{{landmarkContents}}/g, landmarkContents);
}

export function autogenColophon(project: ProjectMetaSchemaType, volume: VolumeMetaSchemaType): string {
  const root = h();

  root.children = [
    h('h1', ['Colophon']),
    h('p', { class: 'section-break' }, [volume.title]),
    h('p', [`by ${project.author.writer}`]),
  ];

  // Teams list
  if (project.teams.length > 0) {
    project.teams.forEach((team, index) => {
      const textData = roleWithName(team.role, team.name);
      if (index === 0) {
        root.children.push(h('p', { class: 'section-break' }, [textData]));
      } else {
        root.children.push(h('p', [textData]));
      }
    });
  }

  // Author info
  root.children.push(
    h('p', { class: 'section-break' }, [`Copyright © ${volume.year} ${project.author.writer}`]),
  );
  if (project.author.illustrator) {
    root.children.push(h('p', [`Illustrated by ${project.author.illustrator}`]));
  }

  // Publisher info
  const publisherName = project.publisher.full_name ?? project.publisher.name;
  root.children.push(
    h('p', { class: 'section-break' }, [
      `First published in ${project.publisher.country} in ${volume.year} by ${publisherName}`,
    ]),
    h('p', { class: 'section-break' }, ['All rights reserved.']),
  );

  // Translator site info
  root.children.push(h('p', { class: 'section-break' }, [project.translator.name]));
  if (project.translator.url) {
    const url = new URL(project.translator.url);
    const hostname = url.hostname.replace(/^www\./, '');
    root.children.push(
      h('p', [
        h(
          'a',
          {
            href: project.translator.url,
          },
          [hostname],
        ),
      ]),
    );
  }
  if (project.translator.image) {
    root.children.push(
      h('p', [
        h('img', {
          src: `../Images/credit-icon-${basename(project.translator.image)}`,
          class: 'credit-icon',
          alt: project.translator.name,
        }),
      ]),
    );
  }

  // Compiler info
  root.children.push(
    h('p', { class: 'section-break' }, [`A compilation project by ${project.compiler.name}`]),
  );
  if (project.compiler.url) {
    const url = new URL(project.compiler.url);
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/$/, '').replace(/^\/+/, '');

    const preferStub = pathname.trim().length > 0 ? pathname.trim() : hostname.trim();
    root.children.push(
      h('p', [
        h(
          'a',
          {
            href: project.compiler.url,
          },
          [preferStub],
        ),
      ]),
    );
  }

  root.children.push(
    h('p', [`Version ${volume.version}, compiled on ${getCompilationDate()}`]),
    h('br'),
    h('p', ['This is a fan translation, and uploaded for free.']),
    h('p', ['If you paid for this you have been scammed.']),
  );

  const hastHtml = hastToHtmlRaw(root);
  return templateColophon.replace(/{{title}}/g, volume.title).replace(/{{content}}/g, hastHtml);
}

export function autogenFootnotes(footnotes: HastElement[], meta: VolumeMetaSchemaType): string {
  const html = hastToHtmlRaw({
    type: 'root',
    children: [h('h1', ['Translation Notes']), ...footnotes],
  });

  return templateFootnotes.replace(/{{title}}/g, meta.title).replace(/{{content}}/g, html);
}

export function autogenNcxFile(meta: VolumeMetaSchemaType, tocs: MetaToC[]): string {
  const hNodes = tocs.map((item, index) => {
    return h(
      'navPoint',
      {
        id: `navPoint${index + 1}`,
        playOrder: (index + 1).toString(),
      },
      [h('navLabel', {}, [h('text', {}, [item.title])]), h('content', { src: `Text/${item.filename}` })],
    );
  });

  const html = hastToHtmlRaw({
    type: 'root',
    children: [h('navMap', {}, hNodes)],
  });

  const htmlFixup = html
    .replace(/<navpoint/g, '<navPoint')
    .replace(/<navlabel/g, '<navLabel')
    .replace(/<navmap/g, '<navMap')
    .replace(/<\/navpoint/g, '</navPoint')
    .replace(/<\/navlabel/g, '</navLabel')
    .replace(/<\/navmap/g, '</navMap');

  return templateNcx
    .replace(/{{title}}/g, meta.title)
    .replace(/{{identifier}}/g, meta.identifier)
    .replace(/{{content}}/g, htmlFixup);
}

export function autogenAuthorSign(authorName: string) {
  return h(
    'p',
    {
      style: 'text-align: right; margin-right: 20pt;',
      class: 'section-break',
    },
    [h('strong', {}, [authorName])],
  );
}

export function generateXHash() {
  const randomString = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(randomString).digest('hex');
  return hash;
}
