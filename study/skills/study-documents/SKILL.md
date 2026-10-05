---
name: study-documents
description: Read uploaded PDFs and Office documents or create downloadable Word, Excel, PowerPoint and PDF deliverables using the study file tools.
---

Use `list_files` to identify the student's supplied files. Use `read_file` for text, CSV, Markdown or JSON. Use `run_python` for PDFs and Office formats.

Python inputs are `/work/inputs/<file-id>-<original-name>`. Pass only the relevant file IDs. Libraries include `fitz` for PDFs, `docx` for Word, `openpyxl` and `pandas` for spreadsheets, `pptx` for presentations and `reportlab` for PDFs. Save deliverables in `/work/outputs`.

Preserve source content and distinguish quoted findings from generated suggestions. Do not invent interview findings. Check generated tables, paragraphs and slide contents before delivering. Use the actual returned download URL for each file. A text outline is not a completed downloadable document.

Computation has no network and a forty-second limit. Split longer work rather than installing packages. For Chinese figures, select Noto Sans CJK SC in matplotlib.
