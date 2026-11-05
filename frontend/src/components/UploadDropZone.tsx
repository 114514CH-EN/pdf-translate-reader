import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useDocStore } from '../stores/doc';

/**
 * Full-window drag & drop overlay for PDF uploads.
 */
export function UploadDropZone({ children }: { children: ReactNode }) {
  const uploadFile = useDocStore((s) => s.uploadFile);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const hasFiles = (e: DragEvent): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith('.pdf')) {
          void uploadFile(file);
        } else {
          useDocStore.setState({ error: '仅支持 PDF 文件' });
        }
      }
    },
    [uploadFile],
  );

  useEffect(() => {
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDragEnter, onDragOver, onDragLeave, onDrop]);

  return (
    <div className="upload-dropzone-root">
      {children}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">松开以上传 PDF</div>
        </div>
      )}
    </div>
  );
}
