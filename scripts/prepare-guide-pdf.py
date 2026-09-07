#!/usr/bin/env python3
"""Prepare watermarked original-layout PDF pages for GuideAdmin, outside the static publish folder."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('pdf', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
output = args.output.resolve()
if output == root/'flipgame' or root/'flipgame' in output.parents:
    parser.error('Private guide pages must remain outside flipgame/; upload them through GuideAdmin.')
output.mkdir(parents=True,exist_ok=True)
if list(output.glob('page-*.jpg')):
    parser.error('Output already contains pages; use a fresh directory to avoid mixed editions.')
subprocess.run(['pdftoppm','-r','200','-jpeg','-jpegopt','quality=92',str(args.pdf),'%s/page'%output],check=True)
pages=sorted(output.glob('page-*.jpg'))
if not pages or any(p.stat().st_size>3*1024*1024 for p in pages):
    raise SystemExit('Check rendered pages: each must be 3 MB or smaller before uploading.')
(output/'source.json').write_text(json.dumps({'sourceName':args.pdf.name,'sha256':hashlib.sha256(args.pdf.read_bytes()).hexdigest(),'pageCount':len(pages),'renderer':'pdftoppm, 200 dpi, JPEG quality 92','note':'Original page layout and existing watermarks retained. No text reflow. Review before upload.'},ensure_ascii=False,indent=2))
print(f'{len(pages)} pages ready in {output}. Upload JPG files in GuideAdmin and select VIP access.')
