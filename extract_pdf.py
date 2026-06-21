import pypdf
import os

pdf_files = [
    "paper_pages/CHI2022_Collaborative_Learning_in_VR_Drey.pdf",
    "paper_pages/Combining virtual reality with asymmetric.pdf"
]

for pdf_file in pdf_files:
    text = ""
    with open(pdf_file, 'rb') as f:
        reader = pypdf.PdfReader(f)
        for i in range(len(reader.pages)): # Extract ALL pages
            text += reader.pages[i].extract_text() + "\n"
    
    out_file = pdf_file + ".txt"
    with open(out_file, 'w', encoding='utf-8') as f:
        f.write(text)
    print(f"Extracted all pages of {pdf_file} to {out_file}")
