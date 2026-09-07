// report-generator.js - shared "Generate Report" flow for every reporting
// dashboard page (Dashboard, Music/About Me/Projects metrics, Performance).
// Loaded once per page via <script src="/assets/report-generator.js">,
// wired up with one ReportGenerator.init(...) call - see the bottom of any
// page that uses it for the exact options.
//
// Flow: capture the page's own content into a canvas (html2canvas) -> let
// the user draw/highlight/add text notes directly on that image in a
// full-screen modal -> ask for a name + notes -> wrap the annotated canvas
// in a one-page PDF (jsPDF) and upload it as base64 to POST /api/reports.
(function () {
  'use strict';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function ensureLibs() {
    var libs = [];
    if (!window.html2canvas) libs.push(loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'));
    if (!window.jspdf) libs.push(loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'));
    return Promise.all(libs);
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'style') node.style.cssText = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  var COLORS = ['#111827', '#dc2626', '#f59e0b', '#16a34a', '#2563eb'];

  function buildModal() {
    var overlay = el('div', { style:
      'position:fixed;inset:0;background:rgba(15,23,42,0.72);z-index:99999;' +
      'display:flex;align-items:center;justify-content:center;padding:2rem;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;'
    });
    var sheet = el('div', { style:
      'background:#fff;border-radius:16px;max-width:min(1000px,95vw);max-height:92vh;width:100%;' +
      'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.35);'
    });
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    return { overlay: overlay, sheet: sheet };
  }

  function fmtStatus(el2, text, isError) {
    el2.textContent = text;
    el2.style.color = isError ? '#dc2626' : '#64748b';
  }

  function runAnnotationStep(sheet, sourceCanvas, onDone, onCancel) {
    sheet.innerHTML = '';

    var toolbar = el('div', { style:
      'display:flex;align-items:center;gap:0.6rem;padding:0.8rem 1.1rem;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;'
    });
    var canvasWrap = el('div', { style: 'flex:1;overflow:auto;background:#f1f5f9;display:flex;align-items:flex-start;justify-content:center;padding:1rem;' });
    var footer = el('div', { style: 'display:flex;justify-content:flex-end;gap:0.6rem;padding:0.8rem 1.1rem;border-top:1px solid #e2e8f0;' });

    var canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    canvas.style.cssText = 'max-width:100%;height:auto;border:1px solid #dbe3ee;border-radius:6px;cursor:crosshair;background:#fff;';
    var ctx = canvas.getContext('2d');

    // Strokes are replayed from scratch on undo/clear instead of trying to
    // erase pixels - simplest correct way to support undo with a plain 2D
    // canvas, and this is at most a few dozen strokes for a one-off report.
    var strokes = [];
    var tool = 'pen';
    var color = COLORS[1];

    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(sourceCanvas, 0, 0);
      strokes.forEach(function (s) {
        if (s.type === 'text') {
          ctx.fillStyle = s.color;
          ctx.font = 'bold ' + s.size + 'px -apple-system,Arial,sans-serif';
          ctx.fillText(s.text, s.x, s.y);
          return;
        }
        ctx.strokeStyle = s.color;
        ctx.globalAlpha = s.type === 'highlight' ? 0.35 : 1;
        ctx.lineWidth = s.type === 'highlight' ? 22 : 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        s.points.forEach(function (p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
    }
    redraw();

    function canvasPos(evt) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / rect.width;
      var scaleY = canvas.height / rect.height;
      var t = evt.touches ? evt.touches[0] : evt;
      return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
    }

    var current = null;
    function start(evt) {
      evt.preventDefault();
      if (tool === 'text') {
        var text = window.prompt('Note text:');
        if (text) {
          var p = canvasPos(evt);
          strokes.push({ type: 'text', text: text, x: p.x, y: p.y, color: color, size: 28 });
          redraw();
        }
        return;
      }
      current = { type: tool, color: color, points: [canvasPos(evt)] };
      strokes.push(current);
    }
    function move(evt) {
      if (!current) return;
      evt.preventDefault();
      current.points.push(canvasPos(evt));
      redraw();
    }
    function end() { current = null; }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    function toolBtn(label, value) {
      var btn = el('button', {
        style: 'border:1px solid #dbe3ee;background:' + (tool === value ? '#0284c7' : '#fff') + ';color:' + (tool === value ? '#fff' : '#0f172a') +
          ';border-radius:7px;padding:0.4rem 0.8rem;font-size:0.82rem;font-weight:600;cursor:pointer;',
        onclick: function () { tool = value; renderToolbar(); }
      }, [label]);
      return btn;
    }

    function renderToolbar() {
      toolbar.innerHTML = '';
      toolbar.appendChild(toolBtn('Pen', 'pen'));
      toolbar.appendChild(toolBtn('Highlighter', 'highlight'));
      toolbar.appendChild(toolBtn('Text', 'text'));
      COLORS.forEach(function (c) {
        toolbar.appendChild(el('button', {
          title: c,
          style: 'width:26px;height:26px;border-radius:50%;border:' + (color === c ? '3px solid #0284c7' : '1px solid #dbe3ee') + ';background:' + c + ';cursor:pointer;padding:0;',
          onclick: function () { color = c; renderToolbar(); }
        }, []));
      });
      var picker = el('input', { type: 'color', value: color, style: 'width:30px;height:26px;border:none;background:none;cursor:pointer;' });
      picker.addEventListener('input', function () { color = picker.value; });
      toolbar.appendChild(picker);
      toolbar.appendChild(el('button', {
        style: 'margin-left:auto;border:1px solid #dbe3ee;background:#fff;border-radius:7px;padding:0.4rem 0.8rem;font-size:0.82rem;font-weight:600;cursor:pointer;',
        onclick: function () { strokes.pop(); redraw(); }
      }, ['Undo']));
      toolbar.appendChild(el('button', {
        style: 'border:1px solid #dbe3ee;background:#fff;border-radius:7px;padding:0.4rem 0.8rem;font-size:0.82rem;font-weight:600;cursor:pointer;',
        onclick: function () { strokes = []; redraw(); }
      }, ['Clear']));
    }
    renderToolbar();

    canvasWrap.appendChild(canvas);

    footer.appendChild(el('button', {
      style: 'border:1px solid #dbe3ee;background:#fff;color:#0f172a;border-radius:8px;padding:0.55rem 1.1rem;font-weight:600;font-size:0.86rem;cursor:pointer;',
      onclick: onCancel
    }, ['Cancel']));
    footer.appendChild(el('button', {
      style: 'border:none;background:#0284c7;color:#fff;border-radius:8px;padding:0.55rem 1.1rem;font-weight:600;font-size:0.86rem;cursor:pointer;',
      onclick: function () { onDone(canvas); }
    }, ['Continue →']));

    sheet.appendChild(el('div', { style: 'padding:1rem 1.1rem 0;font-weight:700;font-size:1.05rem;' }, ['Mark up the report']));
    sheet.appendChild(toolbar);
    sheet.appendChild(canvasWrap);
    sheet.appendChild(footer);
  }

  function runDetailsStep(sheet, annotatedCanvas, sourcePage, onDone, onBack) {
    sheet.innerHTML = '';

    var nameInput = el('input', { type: 'text', placeholder: 'e.g. Music Site — Week of Sept 7', style:
      'width:100%;padding:0.6rem 0.8rem;border:1px solid #dbe3ee;border-radius:7px;font-size:0.9rem;box-sizing:border-box;margin-top:0.3rem;'
    });
    var notesInput = el('textarea', { rows: '4', placeholder: 'Optional notes about this report...', style:
      'width:100%;padding:0.6rem 0.8rem;border:1px solid #dbe3ee;border-radius:7px;font-size:0.9rem;box-sizing:border-box;margin-top:0.3rem;resize:vertical;'
    });
    var status = el('p', { style: 'font-size:0.82rem;margin:0.6rem 0 0;' }, ['']);

    var saveBtn = el('button', {
      style: 'border:none;background:#0284c7;color:#fff;border-radius:8px;padding:0.55rem 1.1rem;font-weight:600;font-size:0.86rem;cursor:pointer;',
      onclick: function () {
        var name = nameInput.value.trim();
        if (!name) { fmtStatus(status, 'A name is required.', true); return; }
        saveBtn.disabled = true;
        fmtStatus(status, 'Saving...', false);
        onDone(name, notesInput.value, status, saveBtn);
      }
    }, ['Save Report']);

    var backBtn = el('button', {
      style: 'border:1px solid #dbe3ee;background:#fff;color:#0f172a;border-radius:8px;padding:0.55rem 1.1rem;font-weight:600;font-size:0.86rem;cursor:pointer;',
      onclick: onBack
    }, ['← Back to markup']);

    var footer = el('div', { style: 'display:flex;justify-content:flex-end;gap:0.6rem;padding:0.8rem 1.1rem;border-top:1px solid #e2e8f0;align-items:center;' }, [status, backBtn, saveBtn]);

    var preview = el('img', { style: 'max-width:220px;max-height:220px;border:1px solid #dbe3ee;border-radius:8px;display:block;' });
    preview.src = annotatedCanvas.toDataURL('image/png');

    var body = el('div', { style: 'padding:1.1rem;overflow:auto;display:flex;gap:1.2rem;flex-wrap:wrap;' }, [
      preview,
      el('div', { style: 'flex:1;min-width:240px;' }, [
        el('label', { style: 'font-size:0.82rem;font-weight:600;color:#334155;' }, ['Report name']),
        nameInput,
        el('label', { style: 'font-size:0.82rem;font-weight:600;color:#334155;display:block;margin-top:0.8rem;' }, ['Notes']),
        notesInput
      ])
    ]);

    sheet.appendChild(el('div', { style: 'padding:1rem 1.1rem 0;font-weight:700;font-size:1.05rem;' }, ['Name this report']));
    sheet.appendChild(body);
    sheet.appendChild(footer);
    nameInput.focus();
  }

  function start(options) {
    var captureEl = document.querySelector(options.captureSelector || 'main');
    if (!captureEl) { window.alert('Nothing found to capture on this page.'); return; }

    var modal = buildModal();
    modal.sheet.appendChild(el('p', { style: 'padding:2rem;text-align:center;color:#64748b;' }, ['Capturing page…']));

    ensureLibs().then(function () {
      return window.html2canvas(captureEl, { backgroundColor: '#f8fafc', scale: 1, useCORS: true });
    }).then(function (sourceCanvas) {
      function showAnnotation() {
        runAnnotationStep(modal.sheet, sourceCanvas, function (annotatedCanvas) {
          showDetails(annotatedCanvas);
        }, function () { modal.overlay.remove(); });
      }
      function showDetails(annotatedCanvas) {
        runDetailsStep(modal.sheet, annotatedCanvas, options.sourcePage, function (name, notes, status, saveBtn) {
          var jsPDF = window.jspdf.jsPDF;
          var pdf = new jsPDF({
            orientation: annotatedCanvas.width > annotatedCanvas.height ? 'l' : 'p',
            unit: 'px',
            format: [annotatedCanvas.width, annotatedCanvas.height]
          });
          pdf.addImage(annotatedCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, annotatedCanvas.width, annotatedCanvas.height);
          var dataUri = pdf.output('datauristring');
          var pdfBase64 = dataUri.slice(dataUri.indexOf(',') + 1);

          fetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, notes: notes, sourcePage: options.sourcePage, pdfBase64: pdfBase64 })
          }).then(function (r) {
            return r.json().then(function (data) { return { ok: r.ok, data: data }; });
          }).then(function (res) {
            if (!res.ok) {
              saveBtn.disabled = false;
              fmtStatus(status, res.data.error || 'Failed to save report.', true);
              return;
            }
            modal.overlay.remove();
          }).catch(function () {
            saveBtn.disabled = false;
            fmtStatus(status, 'Network error - could not save report.', true);
          });
          // "Back to markup" re-enters annotation from the original capture -
          // simplest correct behavior for a back button, even though it means
          // redoing markup rather than restoring the prior annotated state.
        }, showAnnotation);
      }
      showAnnotation();
    }).catch(function (err) {
      modal.sheet.innerHTML = '';
      modal.sheet.appendChild(el('div', { style: 'padding:2rem;text-align:center;' }, [
        el('p', { style: 'color:#dc2626;' }, ['Could not generate report: ' + err.message]),
        el('button', {
          style: 'border:1px solid #dbe3ee;background:#fff;border-radius:8px;padding:0.5rem 1rem;font-weight:600;cursor:pointer;',
          onclick: function () { modal.overlay.remove(); }
        }, ['Close'])
      ]));
    });
  }

  window.ReportGenerator = {
    init: function (options) {
      var btn = document.getElementById(options.buttonId);
      if (!btn) return;
      btn.addEventListener('click', function () { start(options); });
    }
  };
})();
