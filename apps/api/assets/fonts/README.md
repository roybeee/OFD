# Contract PDF font

`NotoSansCJKkr-Regular.otf` is the unmodified Noto Sans CJK KR Regular font
from the official notofonts/noto-cjk repository, distributed under the SIL
Open Font License 1.1. The license is in `OFL-NotoSansCJK.txt`.

Pinned source: https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf

SHA-256: `6bcb2a0703aa137e874fc2dffa85f6c21ba9a67fa329e81b8c801663af7e992a`

Original size: 16,433,112 bytes. PDFKit embeds only the glyph subset needed by
each document. Korean, Hanja, Chinese, Japanese and Vietnamese names and common
units such as ℃ and ㎡ are retained as searchable text.

`infra/scripts/prepare-contract-font.mjs` installs and verifies the exact asset
before API build, test or development. The binary is a generated, ignored build
dependency. A clean build requires access to raw.githubusercontent.com; a cached
file is used only if its checksum matches. Network or checksum failures stop the
build. No runtime font downloads or document data are sent to the font host.
The API Docker image copies the entire `apps/api` directory, including the font
and its license, alongside `src/` and `dist/`.

Unsupported agreement characters are rejected before a draft is frozen, and
again before signing legacy pending contracts. Technical metadata that is not
agreement text, such as User-Agent, uses explicit Unicode escapes when a glyph
is unavailable; its original value remains bound to the signature hash.

Already completed contracts continue to return their original stored PDF bytes.
The previous Nanum Gothic license remains for provenance of earlier documents;
that font is no longer used to generate new PDFs.
