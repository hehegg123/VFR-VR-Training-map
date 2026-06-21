import pypdf

pdf_file = "paper_pages/understanding user experience, task performance and task interdependence in symmetric and asymmetric VR collaborations.pdf"
text = ""
with open(pdf_file, 'rb') as f:
    reader = pypdf.PdfReader(f)
    for i in range(len(reader.pages)):
        text += reader.pages[i].extract_text() + "\n"

out_file = pdf_file + ".txt"
with open(out_file, 'w', encoding='utf-8') as f:
    f.write(text)
print(f"Extracted all pages of {pdf_file} to {out_file}")
