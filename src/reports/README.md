# Report renderers

`json.ts`, `csv.ts`, and `html.ts` turn the report `src/application/report.ts` gathers
into text. They are pure: each receives data and returns a string, reads no file, runs
no command, and never reaches an adapter. Writing the text somewhere is the CLI's job,
through the report service, and publishing it as a file is `src/storage/report-files.ts`.

Byte counts stay exact: decimal strings in JSON and in CSV cells. Every path carries its
raw bytes in base64 beside the sanitized display form. CSV sanitizes every cell and
neutralises one a spreadsheet would evaluate; HTML sanitizes and escapes every value and
carries a Content-Security-Policy that allows nothing but inline styles. See
[cli.md](../../docs/cli.md#reports).
