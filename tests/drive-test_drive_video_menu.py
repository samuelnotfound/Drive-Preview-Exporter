from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    page=browser.new_page()
    page.set_content('''<style>[role=menu]{display:block;width:360px;padding:12px;background:#333;color:#eee}
        [role=menuitem]{display:flex;align-items:center;min-height:32px;gap:10px}</style>
        <div role="menu"><div role="menuitem"><span>Share</span></div>
        <div role="menuitem"><span>Details</span></div>
        <div role="menuitem"><span>Security limitations</span></div></div>''')
    page.add_script_tag(path=str(root/'src/content/drive/ui.js'))
    page.evaluate('''() => {window.GDriveVideoOverlay={getJobId:()=>null};
      window.__PSD.videoCore={isVideoViewerOpen:()=>true};
      window.__PSD.videoQuality={};window.__PSD.videoBridge={};}''')
    page.add_script_tag(path=str(root/'src/content/drive/video.js'))
    result=page.evaluate('''() => {
        const menu=document.querySelector('[role=menu]');
        window.__PSD.video.scanMenu(menu);
        const video=menu.querySelector('#psd-protected-video-menuitem');
        const controls=menu.querySelector('#psd-protected-video-controls');
        return {video:!!video,text:video?.textContent,controls:!!controls,share:menu.querySelector('[role=menuitem] span')?.textContent};
    }''')
    assert result['video'] and result['controls'] and result['share']=='Share',result
    assert 'Export' in result['text'],result
    print('PASS: Drive video Export item and controls remain present;',result)
    browser.close()
