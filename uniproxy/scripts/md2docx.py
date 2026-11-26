# -*- coding: utf-8 -*-
"""Render the uniproxy manuals (Markdown) to styled DOCX files.

Usage:
  python scripts/md2docx.py <source.md> <target.docx> <version> [subtitle] [intro] [toc-label]
"""
import re
import sys
from datetime import date

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Pt, RGBColor

CJK_FONT = "Microsoft YaHei"
MONO_FONT = "Consolas"
ACCENT = RGBColor(0x1F, 0x3A, 0x5F)
BT = chr(96)
INLINE = re.compile(r"(\*\*.+?\*\*|" + BT + r"[^" + BT + r"]+" + BT + r")")


def set_east_asia(run, name=CJK_FONT):
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.append(fonts)
    fonts.set(qn("w:eastAsia"), name)


def shade(paragraph, fill="F3F4F6"):
    paragraph._p.get_or_add_pPr().append(
        parse_xml('<w:shd %s w:val="clear" w:color="auto" w:fill="%s"/>' % (nsdecls("w"), fill))
    )


def shade_cell(cell, fill):
    cell._tc.get_or_add_tcPr().append(
        parse_xml('<w:shd %s w:val="clear" w:color="auto" w:fill="%s"/>' % (nsdecls("w"), fill))
    )


def add_page_number(paragraph):
    run = paragraph.add_run()
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    run._r.addnext(field)


def heading(doc, text, level):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    paragraph.paragraph_format.space_after = Pt(5)
    paragraph.paragraph_format.keep_with_next = True
    run = paragraph.add_run(text)
    run.bold = True
    run.font.color.rgb = ACCENT
    run.font.size = Pt(18 if level == 1 else 14 if level == 2 else 11.5)
    set_east_asia(run)
    if level == 1:
        paragraph._p.get_or_add_pPr().append(
            parse_xml('<w:pBdr %s><w:bottom w:val="single" w:sz="6" w:space="3" w:color="1F3A5F"/></w:pBdr>' % nsdecls("w"))
        )
    return paragraph


def add_inline(paragraph, text, bold=False, size=None):
    pos = 0
    for match in INLINE.finditer(text):
        if match.start() > pos:
            run = paragraph.add_run(text[pos:match.start()])
            run.bold = bold or None
            if size:
                run.font.size = Pt(size)
            set_east_asia(run)
        token = match.group(0)
        if token.startswith("**") and token.endswith("**") and len(token) > 4:
            add_inline(paragraph, token[2:-2], bold=True, size=size)
        else:
            run = paragraph.add_run(token[1:-1])
            run.font.name = MONO_FONT
            run.font.size = Pt((size or 10.5) - 0.5)
            set_east_asia(run)
            run._element.get_or_add_rPr().append(
                parse_xml('<w:shd %s w:val="clear" w:color="auto" w:fill="EEF1F5"/>' % nsdecls("w"))
            )
        pos = match.end()
    if pos < len(text):
        run = paragraph.add_run(text[pos:])
        run.bold = bold or None
        if size:
            run.font.size = Pt(size)
        set_east_asia(run)


def add_code(doc, lines):
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.left_indent = Cm(0.25)
    paragraph.paragraph_format.space_before = Pt(3)
    paragraph.paragraph_format.space_after = Pt(6)
    paragraph.paragraph_format.line_spacing = 1.0
    shade(paragraph)
    for index, code_line in enumerate(lines):
        run = paragraph.add_run(code_line)
        run.font.name = MONO_FONT
        run.font.size = Pt(8.5)
        set_east_asia(run)
        if index != len(lines) - 1:
            run.add_break()


def parse_table(lines):
    rows = []
    for line in lines:
        line = line.strip()
        if not line.startswith("|"):
            continue
        if re.match(r"^\|[\s:|-]+\|$", line):
            continue
        rows.append([cell.strip() for cell in line.strip("|").split("|")])
    return rows


def add_table(doc, rows):
    if not rows:
        return
    width = max(len(row) for row in rows)
    table = doc.add_table(rows=len(rows), cols=width)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    for table_row in table.rows:
        table_row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
    for r, row in enumerate(rows):
        for c in range(width):
            cell = table.cell(r, c)
            cell.text = ""
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(1)
            add_inline(paragraph, row[c] if c < len(row) else "", bold=(r == 0), size=9)
            if r == 0:
                shade_cell(cell, "E8EDF5")
    doc.add_paragraph().paragraph_format.space_after = Pt(0)


def join_lines(lines):
    if not lines:
        return ""
    result = lines[0]
    for nxt in lines[1:]:
        prev = result[-1:] if result else ""
        if prev and ord(prev) > 127 and nxt[:1] and ord(nxt[:1]) > 127:
            result += nxt
        else:
            result += " " + nxt
    return result


def main(source, target, version, subtitle, intro, toc_label):
    lines = open(source, encoding="utf-8").read().splitlines()
    doc = Document()
    section = doc.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21.0)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)

    normal = doc.styles["Normal"]
    normal.font.name = CJK_FONT
    normal.font.size = Pt(10.5)
    normal.paragraph_format.line_spacing = 1.35
    normal.paragraph_format.space_after = Pt(4)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), CJK_FONT)

    header = section.header.paragraphs[0]
    header.text = "uniproxy " + subtitle + " · v" + version
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    for run in header.runs:
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(0x6B, 0x72, 0x80)
        set_east_asia(run)

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_page_number(footer)

    for _ in range(5):
        doc.add_paragraph()
    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run("uniproxy")
    run.bold = True
    run.font.size = Pt(40)
    run.font.color.rgb = ACCENT
    run.font.name = "Segoe UI"

    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = sub.add_run(subtitle)
    run.bold = True
    run.font.size = Pt(24)
    set_east_asia(run)

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = meta.add_run("Version v" + version + "　|　" + date.today().isoformat())
    run.font.size = Pt(11)
    run.font.color.rgb = RGBColor(0x55, 0x5B, 0x66)
    set_east_asia(run)

    doc.add_paragraph()
    lead = doc.add_paragraph()
    lead.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = lead.add_run(intro)
    run.font.size = Pt(10)
    run.italic = True
    run.font.color.rgb = RGBColor(0x55, 0x5B, 0x66)
    set_east_asia(run)
    doc.add_page_break()

    toc_title = doc.add_paragraph()
    run = toc_title.add_run(toc_label)
    run.bold = True
    run.font.size = Pt(18)
    run.font.color.rgb = ACCENT
    set_east_asia(run)
    for entry in [line[3:].strip() for line in lines if line.startswith("## ")]:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Cm(0.4)
        paragraph.paragraph_format.space_after = Pt(2)
        run = paragraph.add_run(entry)
        run.font.size = Pt(10.5)
        set_east_asia(run)
    doc.add_page_break()

    in_code = False
    code_lines = []
    table_lines = []
    paragraph_lines = []
    skip_first_h1 = True

    def flush_paragraph():
        if paragraph_lines:
            paragraph = doc.add_paragraph()
            add_inline(paragraph, join_lines(paragraph_lines))
            paragraph_lines.clear()

    def flush_table():
        if table_lines:
            add_table(doc, parse_table(table_lines))
            table_lines.clear()

    fence = BT * 3
    for raw in lines:
        line_text = raw.rstrip()

        if line_text.startswith(fence):
            flush_paragraph()
            flush_table()
            if in_code:
                add_code(doc, code_lines)
                code_lines = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line_text)
            continue

        if line_text.strip().startswith("|"):
            flush_paragraph()
            table_lines.append(line_text)
            continue
        flush_table()

        if not line_text.strip():
            flush_paragraph()
            continue
        if line_text.startswith("# "):
            if skip_first_h1:
                skip_first_h1 = False
            else:
                heading(doc, line_text[2:].strip(), 1)
            continue
        if line_text.startswith("#### "):
            flush_paragraph()
            heading(doc, line_text[5:].strip(), 4)
            continue
        if line_text.startswith("### "):
            flush_paragraph()
            heading(doc, line_text[4:].strip(), 3)
            continue
        if line_text.startswith("## "):
            flush_paragraph()
            heading(doc, line_text[3:].strip(), 2)
            continue
        if line_text.strip() == "---":
            flush_paragraph()
            continue
        if line_text.startswith("> "):
            flush_paragraph()
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.5)
            run = paragraph.add_run(line_text[2:].strip())
            run.italic = True
            run.font.size = Pt(9.5)
            run.font.color.rgb = RGBColor(0x55, 0x5B, 0x66)
            set_east_asia(run)
            continue
        if line_text.startswith("- "):
            flush_paragraph()
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.75)
            paragraph.paragraph_format.first_line_indent = Cm(-0.35)
            paragraph.paragraph_format.space_after = Pt(2)
            set_east_asia(paragraph.add_run("•  "))
            add_inline(paragraph, line_text[2:].strip())
            continue
        if re.match(r"^\d+\. ", line_text):
            flush_paragraph()
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.75)
            paragraph.paragraph_format.first_line_indent = Cm(-0.45)
            paragraph.paragraph_format.space_after = Pt(2)
            number, rest = line_text.split(". ", 1)
            run = paragraph.add_run(number + ".  ")
            run.bold = True
            set_east_asia(run)
            add_inline(paragraph, rest.strip())
            continue

        paragraph_lines.append(line_text.strip())

    flush_paragraph()
    flush_table()
    if in_code and code_lines:
        add_code(doc, code_lines)

    doc.core_properties.title = "uniproxy " + subtitle + " v" + version
    doc.core_properties.author = "uniproxy"
    doc.save(target)
    print("saved", target)


if __name__ == "__main__":
    args = sys.argv[1:]
    source, target, version = args[0], args[1], args[2]
    subtitle = args[3] if len(args) > 3 else "安装与部署手册"
    intro = args[4] if len(args) > 4 else "按实际操作顺序编写：每一步包含目的、操作、预期结果与排查方式"
    toc_label = args[5] if len(args) > 5 else "目录"
    main(source, target, version, subtitle, intro, toc_label)
