import { basename } from 'node:path';

import matter from 'gray-matter';
import * as prettier from 'prettier';
import prettierPluginXml from '@prettier/plugin-xml';
import type { FootnoteDefinition, FootnoteReference, Image, Root as MdastRoot, RootContent } from 'mdast';
import type { Nodes as HastNodes, Element as HastElement } from 'hast';
import { frontmatter } from 'micromark-extension-frontmatter';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { raw as hastRaw } from 'hast-util-raw';

import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import {
  VolumeFrontmatter,
  type VolumeFrontmatterType,
  type VolumeMetaSchemaType,
  type VolumeToCType,
} from './schema';
import { toHast } from 'mdast-util-to-hast';
import { h } from 'hastscript';
import { toHtml } from 'hast-util-to-html';
import { defaultSchema, sanitize } from 'hast-util-sanitize';
import chapterTemplate from './template/chapter';
import insertTemplate from './template/insert';
import { toString } from 'hast-util-to-string';
import formatXml from 'xml-formatter';

export function fromMarkdownToMdast(fileContent: string): MdastRoot {
  const processed = fromMarkdown(fileContent, {
    extensions: [frontmatter(['yaml']), gfmFootnote()],
    mdastExtensions: [frontmatterFromMarkdown(['yaml']), gfmFootnoteFromMarkdown()],
  });
  return processed;
}

export function extractFrontmatter(fileContent: string): {
  content: string;
  meta: VolumeFrontmatterType;
} {
  const parsed = matter(fileContent);
  const metaCheck = VolumeFrontmatter.parse(parsed.data);
  return {
    content: parsed.content,
    meta: metaCheck,
  };
}

export function mdastToHast(
  mdastRoot: MdastRoot,
  filename: string,
  footNotesReferences: (label: string, filename: string) => { n: number; fn: string },
  footNotesDefinition: (label: string, hastNode: HastElement) => void,
): HastNodes {
  const hastRoot = toHast(mdastRoot, {
    allowDangerousHtml: true,
    clobberPrefix: '',
    handlers: {
      footnoteDefinition: (state, node: FootnoteDefinition) => {
        const label = node.identifier;
        const ref_n = footNotesReferences(label, filename);

        const hastNode = h('p', {}, [
          h('a', {
            id: `def-${ref_n.n}`,
            'epub:type': 'footnote',
          }),
          h(
            'a',
            {
              href: `${ref_n.fn}.xhtml#${state.options.clobberPrefix ?? ''}ref-${ref_n.n}`,
            },
            [h('sup', {}, [`[${ref_n.n}]`])],
          ),
        ]);
        const childrenContent = state.all(node);
        const hastText = toString({
          type: 'root',
          children: childrenContent,
        });
        hastNode.children.push({
          type: 'text',
          value: ` ${hastText}`,
        });
        footNotesDefinition(label, hastNode);
        return undefined;
      },
      footnoteReference: (state, node: FootnoteReference) => {
        const label = node.identifier;
        const ref_n = footNotesReferences(label, filename);

        return [
          h('a', {
            id: `ref-${ref_n.n}`,
            'epub:type': 'noteref',
          }),
          h(
            'a',
            {
              href: `notes.xhtml#${state.options.clobberPrefix ?? ''}def-${ref_n.n}`,
            },
            [h('sup', {}, [`[${ref_n.n}]`])],
          ),
        ];
      },
      image: (state, node: Image) => {
        // Fixup image node src
        const baseSrc = basename(node.url);
        const hastNode = h('img', {
          src: `../Images/${baseSrc}`,
          alt: node.alt,
          title: node.title,
        });
        // Extract the #., which is class name
        const className = node.url.match(/#\.(.*)/);
        if (className) {
          // Remove from src
          // @ts-expect-error
          hastNode.properties.src = hastNode.properties.src!.replace(/#\..*/, '');
          hastNode.properties.class = className[1];
        }

        return hastNode;
      },
      thematicBreak: (state, node) => {
        return h(
          'p',
          {
            class: 'centerp diamond',
          },
          [
            h('span', { style: 'margin-left:1em; margin-right: 1em;' }, ['*']),
            h('span', { style: 'margin-left:1em; margin-right: 1em;' }, ['*']),
            h('span', { style: 'margin-left:1em; margin-right: 1em;' }, ['*']),
          ],
        );
      },
    },
  });

  return hastRaw(hastRoot);
}

export function hastToHtmlRaw(hastRoot: HastNodes): string {
  return toHtml(hastRoot);
}

export function hastToHtml(
  hastRoot: HastNodes,
  filename: string,
  template: 'chapter' | 'insert',
  current: VolumeToCType,
  meta: VolumeMetaSchemaType,
): string {
  const html = hastToHtmlRaw(hastRoot);

  switch (template) {
    case 'chapter': {
      return chapterTemplate(meta, html, filename);
    }
    case 'insert': {
      return insertTemplate(meta, html, filename);
    }
    default: {
      throw new Error(`Unknown template type: ${template}`);
    }
  }
}

/**
 * Automatically split the content of a mdast tree into multiple trees.
 *
 * The function will split the content at each image found OR if it finds a <!-- /split --> comment.
 * To not split an image, add #nosplit to the end of the image src.
 *
 * @param mdastRoot The root node of the mdast tree
 * @returns Multiple mdast trees, each separated by an image or <!-- /split -->
 * @throws Error if mdastRoot is not a root node
 */
export function splitMdastContents(mdastRoot: MdastRoot): (MdastRoot & { fullImage?: boolean })[] {
  // Check if mdastRoot is root
  if (mdastRoot.type !== 'root') {
    throw new Error('mdastRoot is not a `root` node');
  }

  // Each children is a paragraph/heading/text
  // When it's a paragraph and the only child is an image, we split it.
  const splitChildren: (MdastRoot & { fullImage?: boolean })[] = [];
  let currentChildren: RootContent[] = [];
  for (let i = 0; i < mdastRoot.children.length; i++) {
    const child = mdastRoot.children[i]!;
    if (child.type === 'paragraph' && child.children.length === 1 && child.children[0]!.type === 'image') {
      // Get the image src
      const imageSrc = (child.children[0] as Image).url;
      // Check if this a no split
      const isNoSplit = Boolean(imageSrc.match(/\#nosplit$/));
      if (isNoSplit) {
        // If no split, remove the #nosplit from the src
        (child.children[0] as Image).url = imageSrc.replace(/\#nosplit$/, '');
      } else {
        // If split, we need to split the children
        if (currentChildren.length > 0) {
          splitChildren.push({
            type: 'root',
            children: currentChildren,
            position: {
              start: currentChildren[0]!.position!.start,
              end: currentChildren[currentChildren.length - 1]!.position!.end,
            },
          });
        }
        splitChildren.push({
          type: 'root',
          children: [...child.children],
          position: child.position,
          fullImage: true,
        });
        currentChildren = [];
        continue;
      }
    } else if (child.type === 'html' && child.value.match(/<!--\s*\/split\s*-->/)) {
      // If we find a <!-- /split -->, we need to split the children
      if (currentChildren.length > 0) {
        splitChildren.push({
          type: 'root',
          children: currentChildren,
          position: {
            start: currentChildren[0]!.position!.start,
            end: currentChildren[currentChildren.length - 1]!.position!.end,
          },
        });
      }
      currentChildren = [];
      continue;
    }

    currentChildren.push(child);
  }

  if (currentChildren.length > 0) {
    splitChildren.push({
      type: 'root',
      children: currentChildren,
      position: {
        start: currentChildren[0]!.position!.start,
        end: currentChildren[currentChildren.length - 1]!.position!.end,
      },
    });
  }

  return splitChildren;
}

export async function prettifyHtml(html: string): Promise<string> {
  return prettier.format(html, {
    parser: 'html',
    plugins: [prettierPluginXml],
    printWidth: 10000,
    tabWidth: 2,
    useTabs: false,
    proseWrap: 'preserve',
  });
}

export function prettifyXml(xml: string): string {
  return formatXml(xml, {
    collapseContent: true,
    indentation: '  ',
    lineSeparator: '\n',
  });
}
