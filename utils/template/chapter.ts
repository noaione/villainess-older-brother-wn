import type { VolumeToCType, VolumeMetaSchemaType } from '../schema';

const template = `<?xml version='1.0' encoding='utf-8'?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"
      epub:prefix="z3998: http://www.daisy.org/z3998/2012/vocab/structure/#" lang="en" xml:lang="en">

<head>
  <meta content="text/html; charset=UTF-8" http-equiv="default-style" />
  <title>{{title}}</title>
  <link href="../Styles/book.css" rel="stylesheet" type="text/css" />
</head>

<body>
  <section epub:type="bodymatter chapter" id="{{filename}}">
    <div class="main">
      {{content}}
    </div>
  </section>
</body>

</html>`;

export default function chapterTemplate(
  meta: VolumeMetaSchemaType,
  content: string,
  filename: string,
): string {
  const title = meta.title;
  const templateContent = template
    .replace(/{{title}}/g, title)
    .replace(/{{filename}}/g, filename)
    .replace(/{{content}}/g, content);
  return templateContent;
}
