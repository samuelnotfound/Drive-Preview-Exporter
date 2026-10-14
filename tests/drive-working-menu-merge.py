"""Verify a standalone Google Drive menu uses the proven v1.9.12 insertion.

Run on a mocked Drive URL with real Chromium layout. Tests the menu wrapper
collision introduced by Classroom support, native downloads, and click wiring.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import sys
root = Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]
base = '''<!doctype html><html><head><title>Physics Notes.pdf - Google Drive</title>
<style>body{font:14px Arial;background:#242526;color:#eee}
[role=menu]{margin:36px;width:360px;background:#333;color:#eee;padding:6px}
ul{list-style:none;padding:0;margin:0}li{display:flex;gap:12px;align-items:center;height:40px;padding:0 12px}
li svg{width:24px;height:24px}
</style></head><body>
<button id="file" aria-expanded="true">File</button><div role="menu"><ul>
<li role="menuitem"><svg viewBox="0 0 24 24"></svg><span>Share</span></li>
<li role="menuitem"><svg viewBox="0 0 24 24"></svg><span>Details</span></li>
<li role="menuitem"><svg viewBox="0 0 24 24"></svg><span>Print</span></li>
<li role="menuitem" {download_attr}><svg viewBox="0 0 24 24"></svg><span>Download</span></li>
</ul></div></body></html>'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 for state in ['missing', 'disabled', 'enabled']:
  page=browser.new_page(viewport={'width':800,'height':600})
  markup=base.replace("{download_attr}", '' if state == 'enabled' else 'aria-disabled="true"')
  if state == 'missing':
   markup=markup.replace('<li role="menuitem" aria-disabled="true"><svg viewBox="0 0 24 24"></svg><span>Download</span></li>', '')
  page.set_content(markup)
  page.evaluate('''() => {window.__driveHost='drive.google.com';window.__drivePath='/file/d/test/view'}''')
  page.evaluate('''() => { window.chrome = {runtime:{sendMessage:async()=>({success:true}),onMessage:{addListener(){}}}}; }''')
  for source in ['ui.js','pdf.js','bootstrap.js']:
   code=(root/'src/content/drive'/source).read_text().replace('location.hostname','window.__driveHost').replace('location.pathname','window.__drivePath')
   if source=='ui.js':
    page.add_script_tag(content=code)
    page.evaluate('''() => {window._clicked=0;window.__PSD.pdfCapture={hasRenderedPages:()=>true,resetForNewExport(){},resetProgressUI(){},prepare(){window._clicked++}}}''')
   else: page.add_script_tag(content=code)
  if state != 'enabled':
   page.locator('#psd-protected-download-menuitem').wait_for(timeout=4000)
   assert page.locator('#psd-protected-download-menuitem').count()==1
   assert 'Drive Preview Exporter' in page.locator('#psd-protected-download-menuitem').inner_text()
   assert page.locator('li[role=menuitem]').count()==(4 if state == 'missing' else 5)
   if state != 'missing': assert page.locator('li[role=menuitem]').evaluate_all('els=>els.map(el=>el.textContent.trim())')[-1]=='Download'
   page.locator('#psd-protected-download-menuitem').click()
   page.wait_for_function('window._clicked===1')
   # Existing menu rescans do not add duplicates.
   page.evaluate('''() => {window.__PSD.pdf.scanMenu(document.querySelector('[role="menu"]'))}''')
   assert page.locator('#psd-protected-download-menuitem').count()==1
   print('PASS: protected Drive PDF ('+state+'), inner UL, export after Share, single row, click starts capture')
   page.screenshot(path=str(root/'tests/drive-working-menu-merge.png'))
  else:
   assert page.locator('#psd-protected-download-menuitem').count()==0
   print('PASS: ordinary downloadable Drive file retains native Download; no duplicate Export')
  page.close()
 browser.close()
