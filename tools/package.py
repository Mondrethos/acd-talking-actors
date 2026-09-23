#!/usr/bin/env python3
"""Build installable Foundry release assets using only the Python standard library."""
import argparse
import json
from pathlib import Path
import re
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('version', help='Release version, for example 1.1.1')
parser.add_argument('--repository', required=True, help='GitHub owner/repository')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[\w.-]+)?', args.version):
    parser.error('version must be a release version without a v prefix')
if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository):
    parser.error('repository must be owner/repository')

root = Path(__file__).resolve().parent.parent
project = f'https://github.com/{args.repository}'
manifest = json.loads((root / 'module.json').read_text())
manifest.update(
    version=args.version,
    url=project,
    manifest=f'{project}/releases/latest/download/module.json',
    download=f'{project}/releases/download/{args.version}/module.zip',
    bugs=f'{project}/issues',
)
manifest_text = json.dumps(manifest, indent=2) + '\n'
if '#{' in manifest_text:
    raise ValueError('Unresolved manifest placeholder')

files = [root / name for name in ('README.md', 'LICENSE')]
for folder in ('templates', 'scripts', 'styles', 'language'):
    files.extend(path for path in (root / folder).rglob('*') if path.is_file())
archive_names = {str(path.relative_to(root)) for path in files} | {'module.json'}
referenced = manifest['scripts'] + manifest['esmodules'] + manifest['styles']
referenced += [entry['path'] for entry in manifest['languages']]
for filename in referenced:
    if filename not in archive_names:
        raise ValueError(f'Missing manifest asset: {filename}')

args.output.mkdir(parents=True, exist_ok=True)
(args.output / 'module.json').write_text(manifest_text)
with zipfile.ZipFile(args.output / 'module.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('module.json', manifest_text)
    for path in sorted(files):
        archive.write(path, str(path.relative_to(root)))
print(f'Built {args.output}/module.json and module.zip ({len(archive_names)} files)')
