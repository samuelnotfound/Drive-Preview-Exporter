<div align="center">
  <h1>Drive Preview Exporter</h1>
  <p>A Chrome extension for exporting PDF and video previews you can already access in Google Drive, and a lightweight bookmarklet for standalone PDF export.</p>
  <p>
    <a href="https://github.com/samuelnotfound/Drive-Preview-Exporter"><img src="https://img.shields.io/github/stars/samuelnotfound/Drive-Preview-Exporter?style=for-the-badge&color=8B9CF6" alt="GitHub stars"></a>
    <img src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Manifest V3">
  </p>
</div>

Choose the version that suits what you need:

| | **PDF bookmarklet** | **Chrome extension** |
|---|---|---|
| Install required | No | Yes |
| PDF previews | Yes | Yes |
| Video previews | **No** | Yes |
| Best for | Quickly saving a PDF | Regular PDF and video exports |
| Get started | [Open the bookmarklet page](https://samuelnotfound.github.io/Drive-Preview-Exporter/) | [Install the extension](#option-2-install-the-chrome-extension) |

> **Legal Disclaimer:** This tool is provided strictly for educational purposes and personal use. Users are entirely responsible for ensuring they have the legal right to save or export any content and must comply with Google Drive's Terms of Service. The creator of this repository assumes no liability for how this tool is used, nor any consequences resulting from its use.

## What can it do?

- **FASTER** download compared to other similar extensions.
- **Export PDF previews** — captures the pages rendered in the Google Drive or Google Docs viewer and assembles them into a PDF.
- **Export Drive video previews** — detects the audio and video streams made available to the Drive player and combines compatible streams into an MP4.
- **Add an Export option to the interface** — places an export entry in the relevant Google file menu when the normal download option is unavailable.
- **Work without a server-side conversion step** — PDF capture and video processing are handled in the browser.
- **Use the bookmarklet for PDFs** — save a PDF preview without installing the full extension.

Support for additional file types is currently unplanned.

## Get started

### Option 1: Use the PDF bookmarklet

The bookmarklet is the quickest option when you only need PDFs. It does not require installing the extension.

1. Open the [Drive Preview Exporter bookmarklet page](https://samuelnotfound.github.io/Drive-Preview-Exporter/).
2. Follow the page's instructions to add **Drive PDF Export** to your bookmarks bar.
3. Open a PDF preview in Google Drive or Google Docs.
4. Select **Drive PDF Export** from your bookmarks bar and follow the on-screen steps.

**Bookmarklet note:** This option is for PDF previews only. Use the extension for video exports.

### Option 2: Install the Chrome extension

1. [Download the repository as a ZIP](https://github.com/samuelnotfound/Drive-Preview-Exporter/archive/refs/heads/main.zip).
2. Extract the ZIP file somewhere easy to find. Keep the extracted folder in place after installation.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode**.
5. Select **Load unpacked**.
6. Choose the extracted **Drive-Preview-Exporter** folder — the folder containing `manifest.json`.
7. The extension should now appear in your extensions list.

## How to use it

### Export a PDF

#### Option 1: Using Bookmarklet
1. Open the PDF in Google Drive.
2. Click the bookmark **"Drive PDF Export"**.

#### Option 2: Using Extension
1. Open the PDF in Google Drive or Google Docs.
2. Open the **File** menu.
3. Select the extension's **Export** option, or use the bookmarklet if you installed that version.
4. Follow the capture instructions and let the process finish.
5. Save the generated PDF when prompted.

### Export a video

1. Open and play the video preview in Google Drive.
2. Open the **File** menu and choose the extension's **Export** option.
3. Follow the on-screen prompts, including the available quality choice.
4. Keep the tab open while the video is being processed.
5. Save the resulting MP4 when the export completes.

## How it works

### PDF previews

The extension captures each page as it appears in the document viewer, then assembles those captures into a PDF in the browser.

### Video previews

Google Drive's player can receive audio and video as separate streams. The extension detects the streams available to the player and combines compatible streams into one MP4 file. The bundled `mp4-remux` library is used for the remuxing step, without re-encoding the media.

## Troubleshooting

| Problem | Things to try |
|---|---|
| The PDF looks blurry | Increase the viewer zoom to 200% or higher, then start the capture again. |
| PDF capture stops or does not finish | Keep the Google Drive/Docs tab open and in the foreground until capture completes. |
| Video export is slow or fails | Refresh the video tab and try again. Some videos or stream combinations may not be exportable. |
| Export does not appear in the menu | Refresh the page and reopen the File menu. Make sure the extension is enabled. |
| A Classroom file does not work | Open the attachment in a new tab, then use the Drive/Docs page instead of the Classroom preview. |

Still stuck? [Open an issue](https://github.com/samuelnotfound/Drive-Preview-Exporter/issues) and include your browser version, whether you were exporting a PDF or video, and the steps that caused the problem. Remove private file links and personal information from screenshots or logs.

## Credits

### References

- **[salauddinn/gdrive-video-downloader](https://github.com/salauddinn/gdrive-video-downloader)**
- **[iamarghamallick/How-to-download-protected-view-only-files-from-Google-Drive](https://github.com/iamarghamallick/How-to-download-protected-view-only-files-from-Google-Drive)**
- **[zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader](https://github.com/zavierferodova/Google-Drive-View-Only-PDF-Script-Downloader)**
  - **[mhsohan/How-to-download-protected-view-only-files-from-google-drive-](https://github.com/mhsohan/How-to-download-protected-view-only-files-from-google-drive-)**
  - **[zeltox/Google-Drive-PDF-Downloader](https://github.com/zeltox/Google-Drive-PDF-Downloader)**
### Bundled library

- **[mp4-remux](https://github.com/mscststs/mp4-remux)** — tiny pure-JS tool used to merge separate video and audio MP4 streams without re-encoding.

Please refer to those projects for their licenses, source, and notices.

## Disclaimer

- This project was built with assistance from AI tools during development, debugging, refactoring, and documentation.
- It does not remove access restrictions, bypass authentication, or grant access to files the user cannot already view.
- You are responsible for complying with Google Drive’s Terms of Service and applicable law.

This project is provided as-is.
