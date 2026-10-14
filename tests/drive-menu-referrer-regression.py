from pathlib import Path
from playwright.sync_api import sync_playwright
import sys
root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
html_variants={
'iconless': '<div role="menuitem"><span>Details</span></div>',
'svg-direct': '<div role="menuitem"><svg width="24" height="24"><circle cx="10" cy="10" r="5"/></svg><span>Details</span></div>',
'svg-nested': '<div role="menuitem"><span class="icon"><svg width="24" height="24"><circle cx="10" cy="10" r="5"/></svg></span><span>Details</span></div>',
}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    for variant, details in html_variants.items():
      for ref in ['', 'https://classroom.google.com/u/0/c/course/details']:
        page=browser.new_page(viewport={'width':800,'height':500})
        html=f'<title>Biology Notes.pdf - Google Drive</title><style>[role=menu]{{display:block;width:340px;padding:15px;background:#303134;color:white}}[role=menuitem]{{display:flex;align-items:center;min-height:35px;gap:10px;color:white}}</style><div role="menu"><div role="menuitem"><span>Share</span></div>{details}<div role="menuitem"><span>Print</span></div><div role="menuitem" aria-disabled="true"><span>Download</span></div></div>'
        page.set_content(html)
        page.evaluate('''ref => {window.__fakeHostname='drive.google.com';window.__fakePathname='/file/d/abc123/view';Object.defineProperty(document,'referrer',{configurable:true,get(){return ref}});window.chrome={runtime:{sendMessage:async()=>({success:false}),onMessage:{addListener(){}}}};}''',ref)
        for name in ['ui.js','pdf.js']:
            script=(root/'src/content/drive'/name).read_text()
            script=script.replace('location.hostname','window.__fakeHostname').replace('location.pathname','window.__fakePathname')
            page.add_script_tag(content=script)
            if name=='ui.js':page.evaluate('''() => window.__PSD.pdfCapture={hasRenderedPages:()=>true,resetForNewExport(){}}''')
        page.evaluate('''() => window.__PSD.ui.getVisibleFileMenus().forEach(menu=>window.__PSD.pdf.scanMenu(menu))''')
        e=page.locator('#psd-protected-download-menuitem')
        count=e.count();label=e.inner_text() if count else ''
        assert count==1 and 'Export' in label and 'Drive Preview Exporter' in label, (variant,ref,count,label)
        assert e.locator('svg').count()>=1
        assert page.get_by_text('Details',exact=True).count()==1
        print('PASS:',variant,'Classroom referrer' if ref else 'direct Drive', 'visible text',repr(label))
        if variant=='svg-direct' and ref:
            page.screenshot(path=str(root/'tests/drive-export-restored.png'))
        page.close()
    browser.close()
