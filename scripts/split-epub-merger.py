import html
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote
from zipfile import ZipFile

import bs4
import cssutils
from bs4 import BeautifulSoup

CURRENT_DIR = Path(__file__).parent.resolve()

print("Loading templates...")
ROOT_DIR = CURRENT_DIR / ".." / "_RawData"
OEBPS_DIR = ROOT_DIR / "repacked" / "OEBPS"
TEMPLATES_DIR = ROOT_DIR / "repacked" / "_templates"
TARGET_XHTML_REPACK = ROOT_DIR / "Text"
TEMPLATE_XHTML_RAW = (TEMPLATES_DIR / "_templates.xhtml").read_text(encoding="utf-8")


@dataclass
class TOCSeparation:
    title: str
    identifier: str


def read_opf_data(opf_bytes: bytes) -> dict[str, str]:
    opf_data = {}
    opf_tml = BeautifulSoup(opf_bytes, features="xml")
    # Get manifest
    manifest = opf_tml.find("manifest")
    if manifest is None:
        raise ValueError("No manifest found in the OPF file")
    # Get the items in the manifest
    for item in manifest.find_all("item"):
        item: bs4.element.Tag
        # Get the id and href attributes
        item_id = item.get("id")
        item_href = item.get("href")
        if item_id is None or item_href is None:
            continue
        # Decode item_href
        item_href = unquote(item_href)
        # Add to the dictionary
        opf_data[item_id] = item_href
    return opf_data


def parse_toc_separation(raw_data: str) -> list[TOCSeparation]:
    toc_tml = BeautifulSoup(raw_data, "html.parser")
    toc_separation = []
    for li_item in toc_tml.find_all("li"):
        # Check if it has id front
        li_item: bs4.element.Tag
        if li_item.get("id") == "front":
            continue
        # Get a href
        a_tag = li_item.find("a")
        if a_tag is None:
            continue
        # Get the href value
        href = a_tag.get("href")
        if href is None:
            continue
        # Get the internal text
        title = a_tag.get_text().strip()
        if title is None:
            continue

        # Get the identifier from the href
        identifier = href.split("#")[-1]
        if identifier is None:
            continue
        toc_separation.append(TOCSeparation(title=title, identifier=identifier))
    return toc_separation


def find_italics_in_style(raw_style: str) -> list[str]:
    """
    Return a list of all the style name that has italics
    """

    css_parsed: cssutils.css.CSSStyleSheet = cssutils.parseString(html.unescape(raw_style))
    italics_sels = []
    bolded_selectors = []
    for rule in css_parsed.cssRules:
        rule: cssutils.css.CSSStyleRule
        style: cssutils.css.CSSStyleDeclaration = rule.style
        value = style.getPropertyValue("font-style")
        if value == "italic":
            italics_sels.append(rule.selectorText)
        elif value == "bold":
            bolded_selectors.append(rule.selectorText)

        font_weight = style.getPropertyValue("font-weight", True, None)
        if font_weight is not None and font_weight.isdigit():
            font_weight = int(font_weight)
            if font_weight >= 600:
                bolded_selectors.append(rule.selectorText)
    return italics_sels, bolded_selectors


def tag_has_style_selector(tag: bs4.element.Tag, selectors: list[str]) -> bool:
    """
    Check if a tag has a style selector
    """
    # Get the class and id of the tag
    classes = tag.get("class", [])
    id_ = tag.get("id")
    # Check if the selector is in the class or id
    class_selectors = []
    ids_selectors = []
    node_selectors = []
    for selector in selectors:
        if selector.startswith("."):
            class_selectors.append(selector[1:])
        elif selector.startswith("#"):
            ids_selectors.append(selector[1:])
        else:
            node_selectors.append(selector)

    if any(c in classes for c in class_selectors):
        return True
    if id_ and id_.strip("#") in ids_selectors:
        return True
    # Check if it's the node name
    if tag.name in node_selectors:
        return True
    return False


def parse_and_split_main_xhtml(raw_data: str, toc_separation: list[TOCSeparation]) -> tuple[BeautifulSoup, str]:
    main_tml = BeautifulSoup(raw_data, "html.parser")
    # Get the main content
    main_content = main_tml.find("body")
    if main_content is None:
        raise ValueError("No body found in the XHTML file")
    # Split the content into sections

    styles_with_italics = []
    styles_with_bold = []
    for style in main_tml.find_all("style"):
        style: bs4.element.Tag
        italics, bolded_selectors = find_italics_in_style(style.string)
        styles_with_italics.extend(italics)
        styles_with_bold.extend(bolded_selectors)
    print(f" .. .. Found style: {styles_with_italics}\t{styles_with_bold}")

    cloned_templates = BeautifulSoup(TEMPLATE_XHTML_RAW, "html.parser")

    main_titles = None
    parsed_sections: list[BeautifulSoup] = []
    for index, toc_section in enumerate(toc_separation):
        next_toc = toc_separation[index + 1] if index + 1 < len(toc_separation) else None
        # Get the identifier
        identifier = toc_section.identifier
        # get the title
        main_header = main_content.find(id=identifier)
        # Loop sections until we hit the next toc, if no next toc loop until we hit the final node
        if main_header is None:
            continue
        match_group = re.match(r"Chapter [\d]+-[\d]+ (.*) \([\d]+\)", toc_section.title)
        main_titles = match_group.group(1) if match_group else toc_section.title
        current_sections = []
        for next_section in main_header.next_siblings:
            if isinstance(next_section, bs4.element.NavigableString):
                current_sections.append(next_section)
                continue
            if next_toc is not None and next_section.get("id") == next_toc.identifier:
                break
            current_sections.append(next_section)

        for section in current_sections:
            if isinstance(section, bs4.element.Tag):
                has_italic = tag_has_style_selector(section, styles_with_italics)
                has_bold = tag_has_style_selector(section, styles_with_bold)
                inner_html = section.decode_contents().strip()
                inner_text = section.get_text().strip()
                if inner_text == "" and section.name not in ["hr", "br"]:
                    section.clear()
                    section.name = "br"
                    section.attrs.clear()
                    continue
                if has_italic:
                    inner_html = "<em>" + inner_html + "</em>"
                if has_bold:
                    inner_html = "<strong>" + inner_html + "</strong>"
                # Set contents back
                section.clear()
                soupy = BeautifulSoup(f"<div>{inner_html}</div>", "html.parser")
                section.append(soupy)
                section.attrs.clear()

                # Check how many span we have?

                # Find with selectors for the inner contents
                to_be_cleared_attrs: list[bs4.element.Tag] = []
                has_italic_or_bold = False
                for italic_sel in styles_with_italics:
                    italic_tag = section.select(italic_sel)
                    for tag in italic_tag:
                        if tag.name == "span":
                            tag.name = "em"
                            to_be_cleared_attrs.append(tag)
                        else:
                            # Create a new child tag
                            new_tag = cloned_templates.new_tag("em")
                            new_tag.attrs.clear()
                            cloned_tag = BeautifulSoup(str(tag), "html.parser")
                            cloned_tag.attrs.clear()
                            new_tag.append(cloned_tag)
                            tag.replace_with(new_tag)
                        has_italic_or_bold = True
                for bold_sel in styles_with_bold:
                    bold_tag = section.select(bold_sel)
                    for tag in bold_tag:
                        if tag.name == "span":
                            tag.name = "strong"
                            to_be_cleared_attrs.append(tag)
                        else:
                            # Create a new child tag
                            new_tag = cloned_templates.new_tag("strong")
                            new_tag.attrs.clear()
                            tag.attrs.clear()
                            cloned_tag = BeautifulSoup(str(tag), "html.parser")
                            new_tag.append(cloned_tag)
                            tag.replace_with(new_tag)
                        has_italic_or_bold = True
                for tag in to_be_cleared_attrs:
                    tag.attrs.clear()

                if not has_italic_or_bold and len(section.find_all("span")) == 1:
                    base_text = section.get_text()
                    if has_italic:
                        base_text = "<em>" + base_text + "</em>"
                    if has_bold:
                        base_text = "<strong>" + base_text + "</strong>"
                    section.clear()
                    section.append(BeautifulSoup(base_text, "html.parser") if has_bold or has_italic else base_text)
                for span_tag in section.find_all("span"):
                    span_tag.attrs.clear()
        # Merge the sections into one
        merged_section = BeautifulSoup("", "html.parser")
        # last_tag = None
        for section in current_sections:
            if isinstance(section, bs4.element.Tag):
                # # We don't do multiple br/hr tags in a row
                # if section.name in ["br"]:
                #     continue
                # if last_tag == "hr":
                #     continue
                # last_tag = section.name
                if section.name == "hr":
                    section.attrs.clear()
                    section.attrs["style"] = "margin-top: 16px; margin-bottom: 16px;"
                merged_section.append(section)
            elif isinstance(section, bs4.element.NavigableString):
                # last_tag = None
                merged_section.append(section)
        # Loop through and fine duplicate hr tags
        for hr_tag in merged_section.find_all("hr"):
            if hr_tag.find_next_sibling("hr") or hr_tag.find_next_sibling("br"):
                hr_tag.decompose()
        for br_tag in merged_section.find_all("br"):
            if br_tag.find_next_sibling("br") or br_tag.find_next_sibling("hr"):
                br_tag.decompose()
        parsed_sections.append(merged_section)

    # main class div
    main_div = cloned_templates.find("div", {"class": "main"})
    if main_div is None:
        raise ValueError("No main div found in the template")
    if not isinstance(main_div, bs4.element.Tag):
        raise ValueError("Main div is not a tag")
    main_div.clear()

    # Add the title
    title_div = BeautifulSoup(f"<h1>{main_titles}</h1>", "html.parser")
    main_div.append(title_div)
    for section in parsed_sections:
        main_div.append(section)

    return cloned_templates, main_titles


def extract_xhtml_main_from_epub(epub_path: Path):
    with ZipFile(epub_path) as epub_zip:
        package_opf = epub_zip.read("GoogleDoc/package.opf")
        package_opf = read_opf_data(package_opf)

        google_doc_nav = epub_zip.read(f"GoogleDoc/{package_opf['toc']}")
        google_doc_main = epub_zip.read(f"GoogleDoc/{package_opf['main']}")
        # Parse the navigation XHTML to extract TOC separation
        toc_separation = parse_toc_separation(google_doc_nav.decode("utf-8"))
        return parse_and_split_main_xhtml(google_doc_main.decode("utf-8"), toc_separation)


content_opf = (TEMPLATES_DIR / "_templates_content.opf").read_text(encoding="utf-8")
toc_ncx = (TEMPLATES_DIR / "_templates_toc.ncx").read_text(encoding="utf-8")
# Write toc xhtml
toc_xhtml = (TEMPLATES_DIR / "_templates_toc.xhtml").read_text(encoding="utf-8")
toc_tml = BeautifulSoup(toc_xhtml, "html.parser")

list_toc = toc_tml.select_one("#toc ol")
if not isinstance(list_toc, bs4.element.Tag):
    raise ValueError("No list toc found in the template")

opf_tml = BeautifulSoup(content_opf, "xml")
ncx_tml = BeautifulSoup(toc_ncx, "xml")

nav_map_ncx = ncx_tml.find("navMap")
if not isinstance(nav_map_ncx, bs4.element.Tag):
    raise ValueError("No navMap found in the NCX file")

manifest_opf = opf_tml.find("manifest")
if not isinstance(manifest_opf, bs4.element.Tag):
    raise ValueError("No manifest found in the OPF file")
spine_opf = opf_tml.find("spine")
if not isinstance(spine_opf, bs4.element.Tag):
    raise ValueError("No spine found in the OPF file")

toc_sections = [
    {
        "id": "toc-cover",
        "title": "Cover",
        "href": "cover.xhtml",
        "class": "toc-front",
    }
]

print("Loading separated EPUBs...")
for idx, epub in enumerate(ROOT_DIR.glob("*.epub"), 1):
    print(f" ... Processing {epub.name}...")
    templates, ch_title = extract_xhtml_main_from_epub(epub)

    filename = f"Section{idx:04d}.xhtml"
    output_path = TARGET_XHTML_REPACK / filename
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(str(templates), "utf-8")

    toc_sections.append(
        {
            "id": f"toc-chapter{idx}",
            "title": ch_title,
            "href": filename,
            "class": "toc-chapter",
            "style": "margin-top: 16px;" if idx == 1 else None,
        }
    )

print("Generating ToC...")
for idx, toc_sec in enumerate(toc_sections, 1):
    # create new node
    new_tag = toc_tml.new_tag("li")
    new_tag.attrs["id"] = toc_sec["id"]
    new_tag.attrs["class"] = toc_sec["class"]
    if style := toc_sec.get("style"):
        new_tag.attrs["style"] = style

    new_a_tag = toc_tml.new_tag("a")
    new_a_tag.attrs["href"] = toc_sec["href"]
    new_a_tag.append(toc_sec["title"])
    new_tag.append(new_a_tag)
    list_toc.append(new_tag)
    list_toc.append("\n")

    # Add to the navMap
    new_nav_point = ncx_tml.new_tag("navPoint")
    new_nav_point.attrs["id"] = f"navPoint{idx}"
    new_nav_label = ncx_tml.new_tag("navLabel")
    new_nav_label_text = ncx_tml.new_tag("text")
    new_nav_label_text.string = toc_sec["title"]
    new_nav_label.append(new_nav_label_text)
    new_nav_label.append("\n")
    new_nav_point.append(new_nav_label)
    new_nav_point.append("\n")
    new_nav_content = ncx_tml.new_tag("content")
    new_nav_content.attrs["src"] = "Text/" + toc_sec["href"]
    new_nav_point.append(new_nav_content)
    new_nav_point.append("\n")
    nav_map_ncx.append(new_nav_point)
    nav_map_ncx.append("\n")

    # Add to manifest
    new_item = opf_tml.new_tag("item")
    new_item.attrs["id"] = toc_sec["href"]
    new_item.attrs["href"] = "Text/" + toc_sec["href"]
    new_item.attrs["media-type"] = "application/xhtml+xml"
    manifest_opf.append(new_item)
    manifest_opf.append("\n")

    # Add to spine
    new_itemref = opf_tml.new_tag("itemref")
    new_itemref.attrs["idref"] = toc_sec["href"]
    spine_opf.append(new_itemref)
    spine_opf.append("\n")
    if toc_sec["id"] == "toc-cover":
        toc_itemref = opf_tml.new_tag("itemref")
        toc_itemref.attrs["idref"] = "toc.xhtml"
        toc_itemref.attrs["linear"] = "yes"
        spine_opf.append(toc_itemref)
        spine_opf.append("\n")

print("Writing files...")
(TARGET_XHTML_REPACK / "toc.xhtml").write_text(str(toc_tml), "utf-8")
(OEBPS_DIR / "content.opf").write_text(str(opf_tml), "utf-8")
(OEBPS_DIR / "toc.ncx").write_text(str(ncx_tml), "utf-8")
print("Done!")
