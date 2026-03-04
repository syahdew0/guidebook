(function initEditor() {
  const editorRoot = document.getElementById('editor');
  const hiddenInput = document.getElementById('contentHtml');
  const form = document.getElementById('editorForm');
  const imageControls = document.getElementById('imageControls');
  const imageSizeRange = document.getElementById('imageSizeRange');
  const imageSizeValue = document.getElementById('imageSizeValue');
  const presetButtons = Array.from(document.querySelectorAll('.size-preset-btn'));
  const downloadPdfBtn = document.getElementById('downloadPdfBtn');
  const titleInput = form ? form.querySelector('input[name=\"title\"]') : null;

  if (!editorRoot || !hiddenInput || !form || typeof window.Quill === 'undefined') {
    return;
  }

  const initialImageSizes = getInitialImageSizes(editorRoot.innerHTML);

  const quill = new window.Quill('#editor', {
    theme: 'snow',
    placeholder: 'Tulis konten dokumen. Ketik / atau gunakan toolbar untuk format teks.',
    modules: {
      toolbar: {
        container: '#toolbar',
        handlers: {
          image: imageHandler
        }
      }
    }
  });

  function imageHandler() {
    const fileInput = document.createElement('input');
    fileInput.setAttribute('type', 'file');
    fileInput.setAttribute('accept', 'image/*');
    fileInput.click();

    fileInput.onchange = function onFileChange() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = function onLoad() {
        const range = quill.getSelection(true);
        quill.insertEmbed(range ? range.index : quill.getLength(), 'image', reader.result, 'user');
        setTimeout(function selectInsertedImage() {
          const images = quill.root.querySelectorAll('img');
          const newestImage = images[images.length - 1];
          if (newestImage) {
            setActiveImage(newestImage);
            applySize(100);
          }
        }, 0);
      };
      reader.readAsDataURL(file);
    };
  }

  let activeImage = null;

  function getInitialImageSizes(html) {
    const holder = document.createElement('div');
    holder.innerHTML = html || '';
    return Array.from(holder.querySelectorAll('img')).map(function mapSize(img) {
      return parseImageSizePercent(img);
    });
  }

  function parseImageSizePercent(imageEl) {
    const dataSize = Number.parseInt(imageEl.getAttribute('data-width'), 10);
    if (!Number.isNaN(dataSize) && dataSize >= 10 && dataSize <= 100) {
      return dataSize;
    }

    const attrWidth = imageEl.getAttribute('width');
    const attrPercentMatch = (attrWidth || '').match(/^(\d+)%$/);
    if (attrPercentMatch) {
      return Number.parseInt(attrPercentMatch[1], 10);
    }
    const attrNumeric = Number.parseInt(attrWidth, 10);
    if (!Number.isNaN(attrNumeric) && attrNumeric >= 10 && attrNumeric <= 100) {
      return attrNumeric;
    }

    const styleWidth = imageEl.style.width || '';
    const percentMatch = styleWidth.replace(/\s+/g, '').match(/^(\d+)%$/);
    if (percentMatch) {
      return Number.parseInt(percentMatch[1], 10);
    }

    return 100;
  }

  function toggleControls(enabled) {
    if (!imageControls || !imageSizeRange) {
      return;
    }
    imageControls.classList.toggle('is-active', enabled);
    imageSizeRange.disabled = !enabled;
    presetButtons.forEach(function toggleBtn(button) {
      button.disabled = !enabled;
    });
  }

  function setActiveImage(imageEl) {
    if (activeImage) {
      activeImage.classList.remove('selected-image');
    }

    activeImage = imageEl || null;

    if (!activeImage) {
      toggleControls(false);
      if (imageSizeValue) {
        imageSizeValue.textContent = '100%';
      }
      return;
    }

    activeImage.classList.add('selected-image');
    const percent = parseImageSizePercent(activeImage);
    if (imageSizeRange) {
      imageSizeRange.value = String(percent);
    }
    if (imageSizeValue) {
      imageSizeValue.textContent = `${percent}%`;
    }
    toggleControls(true);
  }

  function applySize(percent) {
    if (!activeImage) {
      return;
    }

    const safePercent = Math.max(10, Math.min(100, percent));
    activeImage.style.width = `${safePercent}%`;
    activeImage.style.height = 'auto';
    activeImage.setAttribute('data-width', String(safePercent));
    activeImage.setAttribute('width', `${safePercent}%`);

    if (imageSizeRange) {
      imageSizeRange.value = String(safePercent);
    }
    if (imageSizeValue) {
      imageSizeValue.textContent = `${safePercent}%`;
    }
  }

  quill.root.querySelectorAll('img').forEach(function normalizeImage(img, index) {
    const parsedPercent = parseImageSizePercent(img);
    const restoredPercent = parsedPercent !== 100 ? parsedPercent : initialImageSizes[index] || 100;
    img.style.width = `${restoredPercent}%`;
    img.style.height = 'auto';
    img.setAttribute('data-width', String(restoredPercent));
    img.setAttribute('width', `${restoredPercent}%`);
  });

  quill.root.addEventListener('click', function onEditorClick(event) {
    if (event.target && event.target.tagName === 'IMG') {
      setActiveImage(event.target);
      return;
    }
    setActiveImage(null);
  });

  if (imageSizeRange) {
    imageSizeRange.addEventListener('input', function onRangeInput() {
      applySize(Number(imageSizeRange.value));
    });
  }

  presetButtons.forEach(function bindPreset(button) {
    button.addEventListener('click', function onPresetClick() {
      const targetSize = Number.parseInt(button.getAttribute('data-size'), 10);
      if (!Number.isNaN(targetSize)) {
        applySize(targetSize);
      }
    });
  });

  document.addEventListener('click', function onDocumentClick(event) {
    if (!activeImage) {
      return;
    }
    const insideEditor = editorRoot.contains(event.target);
    const insideControls = imageControls && imageControls.contains(event.target);
    if (!insideEditor && !insideControls) {
      setActiveImage(null);
    }
  });

  form.addEventListener('submit', function onSubmit() {
    if (activeImage) {
      activeImage.classList.remove('selected-image');
    }
    hiddenInput.value = quill.root.innerHTML;
  });

  if (downloadPdfBtn) {
    downloadPdfBtn.addEventListener('click', function onDownloadPdf() {
      if (activeImage) {
        activeImage.classList.remove('selected-image');
      }
      hiddenInput.value = quill.root.innerHTML;

      const action = downloadPdfBtn.getAttribute('data-pdf-action');
      if (!action) {
        return;
      }

      const tempForm = document.createElement('form');
      tempForm.method = 'post';
      tempForm.action = action;
      tempForm.target = '_blank';

      const titleField = document.createElement('input');
      titleField.type = 'hidden';
      titleField.name = 'title';
      titleField.value = titleInput ? titleInput.value : '';

      const contentField = document.createElement('input');
      contentField.type = 'hidden';
      contentField.name = 'contentHtml';
      contentField.value = hiddenInput.value;

      tempForm.appendChild(titleField);
      tempForm.appendChild(contentField);
      document.body.appendChild(tempForm);
      tempForm.submit();
      tempForm.remove();
    });
  }
})();
