// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3 (「README.txt 不是装饰」("README.txt is not decoration"):
//     the user opening this zip three months later must be able to tell what it is. The content must include
//     ① this is a FlowMic record export ② plaintext, whoever gets it can read it
//     ③ the path back in (which page) ④ export timestamp and row count)
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §7 (plaintext's warning obligation)
//
// The note inside the archive. A pure function, so §3's four obligations are
// assertable — a README that drifts out of one of them is a promise the file
// stops keeping, and nobody would notice by reading the code.

import type { FprHeader } from './fpr';

/** The four sentences + three labels, from the locale catalogue. Passed in
 *  rather than imported so this module stays node-testable and locale-free. */
export interface ReadmeText {
  title: string;
  plain: string;
  howto: string;
  files: string;
  exportedLabel: string;
  countLabel: string;
  deviceLabel: string;
  rowsUnit: string;
}

/** Build `README.txt` (§3). CRLF because the reader is Notepad on Windows —
 *  a file whose own note renders as one long line is not the note §3 asks for. */
export function buildReadme(t: ReadmeText, header: FprHeader): string {
  const lines = [
    t.title,
    '',
    t.plain,
    '',
    t.howto,
    '',
    `${t.exportedLabel}${header.exported_at}`,
    `${t.countLabel}${header.count} ${t.rowsUnit}`,
  ];
  // The README line is written only when the header carries a REAL name. The
  // header itself always carries the key (§4.1: explicit `null` when unknown) —
  // that rule is about the machine-readable record, and a human note saying
  // 「导出设备：null」("Exported from device: null") would be the letter of it against its point. Inventing a
  // placeholder is the thing neither of them allows.
  if (header.source.device !== null && header.source.device !== '') {
    lines.push(`${t.deviceLabel}${header.source.device}`);
  }
  lines.push('', t.files);
  return lines.join('\r\n');
}
