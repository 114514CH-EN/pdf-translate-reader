"""Run the test-suite against a throw-away data folder, never the real library."""
import os
import tempfile

os.environ.setdefault("PDFTR_DATA_DIR", tempfile.mkdtemp(prefix="pdftr-test-"))
