/** What can be opened: PDFs, and Word documents (the backend turns those into a PDF). */
export const IMPORT_EXT = ['.pdf', '.docx', '.doc', '.rtf', '.odt'];

export const IMPORT_ACCEPT = [
  ...IMPORT_EXT,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
].join(',');

export const IMPORT_HINT = '仅支持 PDF 和 Word 文件（.pdf .docx .doc .rtf .odt）';

export function canImport(name: string): boolean {
  const n = name.toLowerCase();
  return IMPORT_EXT.some((ext) => n.endsWith(ext));
}

export function isWord(name: string): boolean {
  return canImport(name) && !name.toLowerCase().endsWith('.pdf');
}
