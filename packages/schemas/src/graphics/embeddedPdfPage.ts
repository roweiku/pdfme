import type { ChangeEvent } from 'react';
import type { PDFEmbeddedPage } from '@pdfme/pdf-lib';
import type { Plugin, Schema } from '@pdfme/common';
import type * as CSS from 'csstype';
import { mm2pt } from '@pdfme/common';
import { FileText } from 'lucide';
import {
  convertForPdfLayoutProps,
  addAlphaToHex,
  isEditable,
  readFile,
  createSvgStr,
} from '../utils.js';
import { DEFAULT_OPACITY } from '../constants.js';

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
      // Show PDF page preview placeholder
      const preview = document.createElement('div');
      const previewStyle: CSS.Properties = {
        ...fullSize,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
        border: '1px solid #ddd',
        borderRadius: '2px',
        fontSize: '11px',
        color: '#666',
        gap: '4px',
      };
      Object.assign(preview.style, previewStyle);

      const iconSvg = document.createElement('div');
      iconSvg.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/><path d="M10 16h4"/></svg>';
      preview.appendChild(iconSvg);

      const label = document.createElement('span');
      label.textContent = `PDF Page ${pageIndex + 1}`;
      preview.appendChild(label);

      container.appendChild(preview);
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
