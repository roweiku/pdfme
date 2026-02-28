import type { ChangeEvent } from 'react';
import type { PDFEmbeddedPage } from '@pdfme/pdf-lib';
import type { Plugin, Schema } from '@pdfme/common';
import type * as CSS from 'csstype';
import { mm2pt } from '@pdfme/common';
import { FileText } from 'lucide';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-expect-error - PDFJSWorker import is not properly typed but required for functionality
import PDFJSWorker from 'pdfjs-dist/build/pdf.worker.entry.js';
import {
  convertForPdfLayoutProps,
  addAlphaToHex,
  isEditable,
  readFile,
  createSvgStr,
} from '../utils.js';
import { DEFAULT_OPACITY } from '../constants.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJSWorker as unknown as string;

interface EmbeddedPdfPageSchema extends Schema {
  pageIndex: number;
}

const getCacheKey = (schema: EmbeddedPdfPageSchema, input: string) =>
  `${schema.type}_${schema.pageIndex}_${input.slice(0, 64)}`;

const fullSize = { width: '100%', height: '100%' };

const stripDataUri = (value: string): string => {
  const commaIdx = value.indexOf(',');
  return commaIdx >= 0 ? value.slice(commaIdx + 1) : value;
};

const getPreviewCacheKey = (schema: EmbeddedPdfPageSchema, input: string) =>
  `${schema.type}_preview_${schema.pageIndex}_${input.slice(0, 64)}`;

const renderPdfPageToDataUrl = async (
  value: string,
  pageIndex: number,
  cache: Map<string | number, unknown>,
  cacheKey: string,
): Promise<string> => {
  const cached = cache.get(cacheKey) as string | undefined;
  if (cached) return cached;

  const base64 = stripDataUri(value);
  const pdfBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const pdfDoc = await pdfjsLib.getDocument({ data: pdfBytes, isEvalSupported: false }).promise;
  const page = await pdfDoc.getPage(Math.min(pageIndex + 1, pdfDoc.numPages));
  const viewport = page.getViewport({ scale: 2 });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext('2d')!;
  await page.render({ canvasContext: context, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  cache.set(cacheKey, dataUrl);
  return dataUrl;
};

const embeddedPdfPageSchema: Plugin<EmbeddedPdfPageSchema> = {
  pdf: async (arg) => {
    const { value, schema, pdfDoc, page, _cache } = arg;
    if (!value) return;

    const pageIndex = schema.pageIndex ?? 0;
    const cacheKey = getCacheKey(schema, value);
    let embeddedPage = _cache.get(cacheKey) as PDFEmbeddedPage | undefined;

    if (!embeddedPage) {
      const base64 = stripDataUri(value);
      const pdfBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const embeddedPages = await pdfDoc.embedPdf(pdfBytes, [pageIndex]);
      embeddedPage = embeddedPages[0];
      _cache.set(cacheKey, embeddedPage);
    }

    // Contain mode: fit embedded page into schema box while preserving aspect ratio
    const _schema = { ...schema, position: { ...schema.position } };
    const srcWidthMm = embeddedPage.width / (72 / 25.4);
    const srcHeightMm = embeddedPage.height / (72 / 25.4);
    const boxWidth = _schema.width;
    const boxHeight = _schema.height;

    const srcRatio = srcWidthMm / srcHeightMm;
    const boxRatio = boxWidth / boxHeight;

    if (srcRatio > boxRatio) {
      _schema.width = boxWidth;
      _schema.height = boxWidth / srcRatio;
      _schema.position.y += (boxHeight - _schema.height) / 2;
    } else {
      _schema.width = boxHeight * srcRatio;
      _schema.height = boxHeight;
      _schema.position.x += (boxWidth - _schema.width) / 2;
    }

    const pageHeight = page.getHeight();
    const lProps = convertForPdfLayoutProps({ schema: _schema, pageHeight });
    const { width, height, rotate, position, opacity } = lProps;
    const { x, y } = position;

    page.drawPage(embeddedPage, { x, y, width, height, rotate, opacity });
  },

  ui: (arg) => {
    const {
      value,
      rootElement,
      mode,
      onChange,
      stopEditing,
      tabIndex,
      theme,
      schema,
      _cache,
    } = arg;
    const editable = isEditable(mode, schema);
    const pageIndex = (schema as EmbeddedPdfPageSchema).pageIndex ?? 0;
    const hasValue = !!value;

    const container = document.createElement('div');
    const containerStyle: CSS.Properties = {
      ...fullSize,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      position: 'relative',
    };
    Object.assign(container.style, containerStyle);
    container.addEventListener('click', (e) => {
      if (editable) {
        e.stopPropagation();
      }
    });
    rootElement.appendChild(container);

    if (hasValue) {
      // Render actual PDF page preview
      const previewCacheKey = getPreviewCacheKey(schema as EmbeddedPdfPageSchema, value);
      const cachedDataUrl = _cache.get(previewCacheKey) as string | undefined;

      if (cachedDataUrl) {
        const img = document.createElement('img');
        const imgStyle: CSS.Properties = {
          height: '100%',
          width: '100%',
          borderRadius: '0',
          objectFit: 'contain',
        };
        Object.assign(img.style, imgStyle);
        img.src = cachedDataUrl;
        container.appendChild(img);
      } else {
        // Show loading placeholder while rendering
        const loading = document.createElement('div');
        const loadingStyle: CSS.Properties = {
          ...fullSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f5f5f5',
          fontSize: '11px',
          color: '#999',
        };
        Object.assign(loading.style, loadingStyle);
        loading.textContent = `Loading PDF Page ${pageIndex + 1}...`;
        container.appendChild(loading);

        renderPdfPageToDataUrl(value, pageIndex, _cache, previewCacheKey)
          .then((dataUrl) => {
            const img = document.createElement('img');
            const imgStyle: CSS.Properties = {
              height: '100%',
              width: '100%',
              borderRadius: '0',
              objectFit: 'contain',
            };
            Object.assign(img.style, imgStyle);
            img.src = dataUrl;
            container.replaceChild(img, loading);
          })
          .catch((err) => {
            console.error('Failed to render PDF page preview:', err);
            loading.textContent = `PDF Page ${pageIndex + 1}`;
          });
      }
    }

    // Remove button
    if (hasValue && editable) {
      const button = document.createElement('button');
      button.textContent = 'x';
      const buttonStyle: CSS.Properties = {
        position: 'absolute',
        top: '0',
        left: '0',
        zIndex: '1',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        color: '#333',
        background: '#f2f2f2',
        borderRadius: '2px',
        border: '1px solid #767676',
        cursor: 'pointer',
        height: '24px',
        width: '24px',
      };
      Object.assign(button.style, buttonStyle);
      button.addEventListener('click', () => {
        if (onChange) onChange({ key: 'content', value: '' });
      });
      container.appendChild(button);
    }

    // File input for uploading PDF
    if (!hasValue && editable) {
      const label = document.createElement('label');
      const labelStyle: CSS.Properties = {
        ...fullSize,
        display: 'flex',
        position: 'absolute',
        top: '0',
        backgroundColor: addAlphaToHex(theme.colorPrimaryBg, 30),
        cursor: 'pointer',
      };
      Object.assign(label.style, labelStyle);
      container.appendChild(label);

      const input = document.createElement('input');
      const inputStyle: CSS.Properties = {
        ...fullSize,
        position: 'absolute',
        top: '50%',
        left: '50%',
        width: '180px',
        height: '30px',
        marginLeft: '-90px',
        marginTop: '-15px',
      };
      Object.assign(input.style, inputStyle);
      input.tabIndex = tabIndex || 0;
      input.type = 'file';
      input.accept = 'application/pdf';
      input.addEventListener('change', (event: Event) => {
        const changeEvent = event as unknown as ChangeEvent<HTMLInputElement>;
        readFile(changeEvent.target.files)
          .then((result) => {
            if (onChange) onChange({ key: 'content', value: result as string });
          })
          .catch((error) => {
            console.error('Error reading file:', error);
          });
      });
      input.addEventListener('blur', () => {
        if (stopEditing) stopEditing();
      });
      label.appendChild(input);
    }
  },

  propPanel: {
    schema: {
      pageIndex: {
        title: 'Page Index',
        type: 'number',
        widget: 'inputNumber',
        default: 0,
        min: 0,
        props: {
          min: 0,
          step: 1,
        },
      },
    },
    defaultSchema: {
      name: '',
      type: 'embeddedPdfPage',
      content: '',
      position: { x: 0, y: 0 },
      width: 50,
      height: 65,
      rotate: 0,
      opacity: DEFAULT_OPACITY,
      pageIndex: 0,
    },
  },
  icon: createSvgStr(FileText),
};

export default embeddedPdfPageSchema;
