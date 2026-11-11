Text detection and recognition models for 「翻译图片文字」 (backend/app/services/ocr.py).

- `det.onnx` — PP-OCRv4 mobile text detection
- `rec.onnx` — PP-OCRv4 mobile text recognition (Chinese + English; the character list is in the model's metadata)

From PaddleOCR (https://github.com/PaddlePaddle/PaddleOCR), converted to ONNX by the RapidOCR project
(https://github.com/RapidAI/RapidOCR, package rapidocr-onnxruntime 1.4.4). Both are under the Apache License 2.0.
