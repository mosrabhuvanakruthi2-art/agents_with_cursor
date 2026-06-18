require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const driveClient = require('../src/clients/driveClient');
const { Document, Paragraph, TextRun, ExternalHyperlink, Packer } = require('docx');

const EMAIL  = 'zara@storefuze.com';
const FOLDER = '1FUuOzrxXajjBRGNNiCCOLQOnezfwMSZu'; // Embedded Links

// 50 unique file links from Agent My Drive root (5 per doc × 10 docs)
const ALL_LINKS = [
  { name: 'root_google_slide',      url: 'https://docs.google.com/presentation/d/1RLbGevgOO1THBCqNAHLz_Uoc8IKr-7pUZCWr59_jtbs/edit?usp=drivesdk' },
  { name: 'root_google_sheet',      url: 'https://docs.google.com/spreadsheets/d/1XlnRCUUa-CzUzpKL6gCHaRu7GiY-c43Yxr79HzYhQSY/edit?usp=drivesdk' },
  { name: 'root_google_doc',        url: 'https://docs.google.com/document/d/1f5wtUGe7JY58JfpdpmDuzzA7SGDybx4F-Su8ZyGgBk0/edit?usp=drivesdk' },
  { name: 'root_archive.7z',        url: 'https://drive.google.com/file/d/1NyJnJt_tX3xT8n9Q2eyydWu5cMAOiMQS/view?usp=drivesdk' },
  { name: 'root_archive.rar',       url: 'https://drive.google.com/file/d/1nxLnh7aKYg_Hq8jv-reJehPxpPH3ONhe/view?usp=drivesdk' },
  { name: 'root_archive.gz',        url: 'https://drive.google.com/file/d/12Q5NvL7G5Wa2S0ATPQInN2s7Yr-ZOGxK/view?usp=drivesdk' },
  { name: 'root_archive.tar',       url: 'https://drive.google.com/file/d/1aXYzPXJcbLStszuJHtcgol8DAr75YWII/view?usp=drivesdk' },
  { name: 'root_archive.zip',       url: 'https://drive.google.com/file/d/1xEAv-ltgMiVR_u2qrtPHsju_BOg0efdT/view?usp=drivesdk' },
  { name: 'root_video.wmv',         url: 'https://drive.google.com/file/d/1B-yx_jFbWx7VCx6IVthcoGsUNrUfYXsz/view?usp=drivesdk' },
  { name: 'root_video.mkv',         url: 'https://drive.google.com/file/d/1DWCPmUDmwZvhdtBl_oBM6sXAsUOZSDRi/view?usp=drivesdk' },
  { name: 'root_video.mov',         url: 'https://drive.google.com/file/d/1RPpmtxxH7G0jqzgYlMgHmjyAJqdLrTnv/view?usp=drivesdk' },
  { name: 'root_video.avi',         url: 'https://drive.google.com/file/d/1qkakBuOWGFwT9FQo2QMj8en8vUWG9wWy/view?usp=drivesdk' },
  { name: 'root_video.mp4',         url: 'https://drive.google.com/file/d/1X8U5NdiHUQviIBFdbBADRFo1DK-7hiyW/view?usp=drivesdk' },
  { name: 'root_audio.flac',        url: 'https://drive.google.com/file/d/1ZEfISq4KFnOQtw8iZF0MJoN1EogDbkqi/view?usp=drivesdk' },
  { name: 'root_audio.ogg',         url: 'https://drive.google.com/file/d/1FXLbPqrYz2G1di9qNMhhMY0aKIqw8PJi/view?usp=drivesdk' },
  { name: 'root_audio.aac',         url: 'https://drive.google.com/file/d/14aL5rlv-GL-KoxjlWp08HsaMUAq8bLJL/view?usp=drivesdk' },
  { name: 'root_audio.wav',         url: 'https://drive.google.com/file/d/12ZftA-J9Q2slPMmCelMqXzz3WPfY_R47/view?usp=drivesdk' },
  { name: 'root_audio.mp3',         url: 'https://drive.google.com/file/d/1JRsGp9cR-Cpg2TcMpSjRK1SVKKILkCKE/view?usp=drivesdk' },
  { name: 'root_photo.webp',        url: 'https://drive.google.com/file/d/1YRyQU4DAjbyNWDVTAfTC3yPPKE2T0dSA/view?usp=drivesdk' },
  { name: 'root_photo.tiff',        url: 'https://drive.google.com/file/d/122oDfGzyHg4tWACYYqPVLAw6n8xbMo3J/view?usp=drivesdk' },
  { name: 'root_vector.svg',        url: 'https://drive.google.com/file/d/1-ov7BFHwkZXqtRvf9asB27ctMOolRKwS/view?usp=drivesdk' },
  { name: 'root_bitmap.bmp',        url: 'https://drive.google.com/file/d/18Ikmyt-WVTBoaUIzHjvz1MdraSYuUhQC/view?usp=drivesdk' },
  { name: 'root_animation.gif',     url: 'https://drive.google.com/file/d/1fsya4uZ4l8RtXP127yWzB6kGfka3wqwd/view?usp=drivesdk' },
  { name: 'root_image.png',         url: 'https://drive.google.com/file/d/1chBuQRcgBc5pC1U6xeYtO_CTxm5U4vLn/view?usp=drivesdk' },
  { name: 'root_photo.jpg',         url: 'https://drive.google.com/file/d/12AL93yhDCCOULBdz9H64SsGLGjsCM-gg/view?usp=drivesdk' },
  { name: 'root_ppt_legacy.ppt',    url: 'https://docs.google.com/presentation/d/1n_DkHuXZAMZkInqvpkdManl9cpndYbCW/edit?usp=drivesdk' },
  { name: 'root_excel_legacy.xls',  url: 'https://docs.google.com/spreadsheets/d/1eByB4yL7Pj3Rwur49k9CQDd9lvyFT9CT/edit?usp=drivesdk' },
  { name: 'root_word_legacy.doc',   url: 'https://docs.google.com/document/d/1QInFilRyI2SUNoTidz_nxztY3utwSo1K/edit?usp=drivesdk' },
  { name: 'root_powerpoint.pptx',   url: 'https://docs.google.com/presentation/d/12Z0Vu4oUAgX2afr5PQSKK9b--Kgvwkta/edit?usp=drivesdk' },
  { name: 'root_excel.xlsx',        url: 'https://docs.google.com/spreadsheets/d/1AqWHw67Asfhp1zjBHdWLquHDaKWprl1v/edit?usp=drivesdk' },
  { name: 'root_word.docx',         url: 'https://docs.google.com/document/d/1HG-NQBjDKa3H2_tZwBLHh7CYo3U13iHy/edit?usp=drivesdk' },
  { name: 'root_document.pdf',      url: 'https://drive.google.com/file/d/1ZyJGYb4Lpf9DEInPST-t7kcqI8Rk4wXi/view?usp=drivesdk' },
  { name: 'root_data.tsv',          url: 'https://drive.google.com/file/d/18SytP-aD4cSWx6c8gjQZVcxyjvg1WGxC/view?usp=drivesdk' },
  { name: 'root_data.csv',          url: 'https://drive.google.com/file/d/1q8ZSXE_WjOnEIFTBcrdw_Uxc3m4C821S/view?usp=drivesdk' },
  { name: 'root_data.xml',          url: 'https://drive.google.com/file/d/1aPnSGKrG1q4_sxq-IFVOQnNQUKPWX0dD/view?usp=drivesdk' },
  { name: 'root_config.yml',        url: 'https://drive.google.com/file/d/1gMIzOhaJTqVESmIIbv0ElogN6yFvu1Qd/view?usp=drivesdk' },
  { name: 'root_config.yaml',       url: 'https://drive.google.com/file/d/1-ylqVvJXuWdYA8-T0_7W5v82OcUkAmSB/view?usp=drivesdk' },
  { name: 'root_data.json',         url: 'https://drive.google.com/file/d/1YCa4hkkk6Hza0e3fLYguvFcy31HL7fPP/view?usp=drivesdk' },
  { name: 'root_query.sql',         url: 'https://drive.google.com/file/d/1tF8x8_oK0z3fWWYfszhy1lNftl8Qz4tf/view?usp=drivesdk' },
  { name: 'root_script.sh',         url: 'https://drive.google.com/file/d/1lY-8DO4XIyLyDJJZmJ2naRNk5P9fWFz5/view?usp=drivesdk' },
  { name: 'root_script.cpp',        url: 'https://drive.google.com/file/d/1nx2hQxEvFnNCf-oms8bpwhq18L6ySjLB/view?usp=drivesdk' },
  { name: 'root_script.java',       url: 'https://drive.google.com/file/d/1eGgZRwkLaVYArWquyN_DrMNul9jrJkUq/view?usp=drivesdk' },
  { name: 'root_script.py',         url: 'https://drive.google.com/file/d/14gmbo9JXxDg2QVSTP3mP-dloSojh4lpj/view?usp=drivesdk' },
  { name: 'root_script.ts',         url: 'https://drive.google.com/file/d/1EjFld_6shnqQ1VljKBVtJ4qmWPjDAQEm/view?usp=drivesdk' },
  { name: 'root_script.js',         url: 'https://drive.google.com/file/d/1DF6RVYoP8pPM4u2wFUlZ6pVhdv46amxC/view?usp=drivesdk' },
  { name: 'root_stylesheet.css',    url: 'https://drive.google.com/file/d/1i1CbDUICnDwDIkDW4rj3AVgvPy1pdvDE/view?usp=drivesdk' },
  { name: 'root_webpage.html',      url: 'https://drive.google.com/file/d/1wM0cS89fRVoqpmMpcZWI6kgWiQWdwC3b/view?usp=drivesdk' },
  { name: 'root_config.ini',        url: 'https://drive.google.com/file/d/1EnJ_jUS3t_e_EPVDU0XOvygMk5FnLncS/view?usp=drivesdk' },
  { name: 'root_log.log',           url: 'https://drive.google.com/file/d/1xAmdeDvnoWNF6wUhjChjlhtcYjnmD0-m/view?usp=drivesdk' },
  { name: 'root_rich_text.rtf',     url: 'https://drive.google.com/file/d/1CfsXA37gXnUOqFdx-QcZuOpwE3C__b4e/view?usp=drivesdk' },
];

function buildDoc(docNum, links) {
  return new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun(`This document contains 5 embedded links to files in Google Drive:`),
          ],
          spacing: { after: 200 },
        }),
        ...links.map((link, i) =>
          new Paragraph({
            children: [
              new TextRun(`${i + 1}. `),
              new ExternalHyperlink({
                link: link.url,
                children: [new TextRun({ text: link.name, style: 'Hyperlink' })],
              }),
            ],
            spacing: { after: 120 },
          })
        ),
      ],
    }],
  });
}

async function run() {
  // Delete existing embedded_link.docx
  try {
    await driveClient.deleteFile('1p27ntEBCQvkIkKnBY1aTa49Yf7lEmJH3', EMAIL);
    console.log('Deleted old embedded_link.docx\n');
  } catch (_) {}

  console.log('Creating 10 DOCX files with 5 unique links each...\n');

  for (let i = 0; i < 10; i++) {
    const docNum  = String(i + 1).padStart(2, '0');
    const links   = ALL_LINKS.slice(i * 5, i * 5 + 5);
    const name    = `embedded_doc_${docNum}.docx`;
    const doc     = buildDoc(i + 1, links);
    const buffer  = await Packer.toBuffer(doc);
    const result  = await driveClient.uploadFile(
      name,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
      FOLDER,
      EMAIL
    );
    console.log(`  ✓ ${name} → ${result.id}`);
    links.forEach((l, j) => console.log(`       link ${j + 1}: ${l.name}`));
    console.log();
  }

  console.log('Done — 10 files created in Embedded Links folder.');
}

run().catch(console.error);