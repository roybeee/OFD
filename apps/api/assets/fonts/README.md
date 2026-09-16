# Korean PDF font

`NanumGothic-Regular.ttf` is the unmodified Nanum Gothic Regular font from
Google Fonts, distributed under the SIL Open Font License 1.1. The complete
copyright and license are in `OFL-NanumGothic.txt`.

Pinned source: https://github.com/google/fonts/tree/16680f8688ffcd467d2eb2146a9ce0343404581d/ofl/nanumgothic

`infra/scripts/prepare-contract-font.mjs` installs and verifies the exact SHA-256
before API build, test or development. The binary is a generated, ignored build
dependency. A clean build requires access to raw.githubusercontent.com; a cached
file is used only if its checksum matches. Network or checksum failures stop the
build. The OFL license remains versioned with the application.

The API embeds a subset of this font into contract PDFs, so Korean text is
searchable and does not depend on fonts installed on the reader's device.
Keep these assets alongside `src/` and `dist/`; the API Docker image copies
the entire `apps/api` directory, including this directory.
