from pathlib import Path
from playwright.sync_api import sync_playwright
import fitz
import sys

root = Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
out = Path(__file__).resolve().parent
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page(accept_downloads=True)
    page.set_content('''<title>Drive Test.pdf - Google Drive</title>
      <section id="preview"><div class="pdf-page"></div><div class="pdf-page"></div><div class="pdf-page"></div></section>''')
    page.evaluate('''async () => {
      const colors = ['#ee2211','#22cc55','#1155ee'];
      const pages = [...document.querySelectorAll('.pdf-page')];
      async function addBlobImage(parent, color) {
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,640,480);
        const blob = await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const img=new Image();img.src=URL.createObjectURL(blob);
        await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject});
        parent.appendChild(img);
      }
      for (let i=0;i<3;i++) await addBlobImage(pages[i],colors[i]);
      // A second high-resolution image inside the same page is valid in Drive;
      // Classroom's newer ambiguity checks wrongly reject the entire page.
      await addBlobImage(pages[1],'#ffffff');
      window.__PSD={pdfState:{status:'idle',runId:0,stopRequested:false,capturedPages:new Map()},
       isDocumentViewer:()=>true,isDrivePage:()=>true,isClassroomViewer:()=>false,
       pdf:{isPageDocumentPreview:()=>true},
       ui:{showInPageOverlay(){},showScrollDim(){},updateWindowControl(){},
           updateInPageOverlay(){},failInPageOverlay(){}}};
      window.chrome={runtime:{sendMessage:async()=>({success:true})}};
    }''')
    page.add_script_tag(path=str(root/'src/content/drive/pdf/capture.js'))
    page.add_script_tag(path=str(root/'src/content/drive/pdf/writer.js'))
    with page.expect_download(timeout=20000) as download_info:
        page.evaluate('''() => { void window.__PSD.pdfCapture.prepare(); }''')
    download=download_info.value
    saved=out/'standalone-drive-regression.pdf'
    download.save_as(str(saved))
    assert download.suggested_filename=='Drive Test.pdf', download.suggested_filename
    doc=fitz.open(saved)
    assert doc.page_count==3,doc.page_count
    centers=[]
    for idx in range(doc.page_count):
        pix=doc.load_page(idx).get_pixmap(matrix=fitz.Matrix(0.3,0.3), alpha=False)
        x=pix.width//2;y=pix.height//2
        centers.append(pix.pixel(x,y))
    assert centers[0][0] > centers[0][1] and centers[0][0] > centers[0][2],centers
    assert centers[1][1] > centers[1][0] and centers[1][1] > centers[1][2],centers
    assert centers[2][2] > centers[2][1] and centers[2][2] > centers[2][0],centers
    print('PASS: 3-page Drive PDF download; correct title; colors red,green,blue;',centers)
    browser.close()
