FROM python:3.12-slim
RUN pip install --no-cache-dir pandas matplotlib python-docx openpyxl python-pptx pymupdf reportlab \
    && apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV MPLBACKEND=Agg OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /work
USER 1000:1000
CMD ["python", "-I", "/work/job.py"]
