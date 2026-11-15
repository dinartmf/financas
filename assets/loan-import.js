/*
 * Importação do extrato de evolução de financiamento (PDF do banco).
 * Todo o processamento acontece no navegador: o PDF nunca é enviado a nenhum servidor.
 * Apenas a tabela de parcelas e os números do contrato são guardados —
 * nome, CPF e endereço do mutuário são descartados.
 */
'use strict';
const LoanImport = (() => {
  const NUM = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$/;
  const DATE = /^\d{2}\/\d{2}\/\d{2,4}$/;
  const MES = {jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12};

  const toNum = s => Number(String(s).replace(/\./g, '').replace(',', '.'));
  const pad = n => String(n).padStart(2, '0');
  function toISO(d) {               // 08/12/24 ou 08/12/2024 -> 2024-12-08
    const [dd, mm, yy] = d.split('/');
    const y = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    return `${y}-${pad(mm)}-${pad(dd)}`;
  }
  function textDateISO(s) {         // " 8/Nov/2024" -> 2024-11-08
    const m = String(s).match(/(\d{1,2})\/([A-Za-zç]{3})\/(\d{4})/);
    if (!m) return null;
    const mm = MES[m[2].toLowerCase()];
    return mm ? `${m[3]}-${pad(mm)}-${pad(m[1])}` : null;
  }
  function addMonthsISO(iso, n) {
    let [y, m, d] = iso.split('-').map(Number); m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
    const dim = new Date(y, m, 0).getDate();
    return `${y}-${pad(m)}-${pad(Math.min(d, dim))}`;
  }
  const grab = (text, re) => { const m = text.match(re); return m ? m[1].trim() : null; };

  /* ---------- 1) PDF -> linhas de texto (navegador) ---------- */
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      const base = new URL('assets/vendor/pdfjs/', document.baseURI).href;
      pdfjsPromise = import(base + 'pdf.min.js').then(lib => {
        lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
        return lib;
      });
    }
    return pdfjsPromise;
  }
  async function extractLines(data, lib) {
    lib = lib || await loadPdfJs();
    const task = lib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const vp = page.getViewport({ scale: 1 });   // considera rotação da página
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = lib.Util.transform(vp.transform, it.transform);
        const x = t[4], y = -t[5];                   // y do dispositivo cresce para baixo
        let row = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!row) { row = { y, items: [] }; rows.push(row); }
        row.items.push({ x, w: it.width || 0, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let out = '', end = null;
        for (const it of r.items) {
          if (end !== null && it.x - end > 1.5) out += ' ';
          out += it.s; end = it.x + it.w;
        }
        lines.push(out.replace(/\s+/g, ' ').trim());
      }
    }
    try { await task.destroy(); } catch (e) { /* ignora */ }
    return lines;
  }

  /* ---------- 2) linhas -> contrato + parcelas (função pura) ---------- */
  function parse(lines) {
    const text = lines.join('\n');
    const contract = {
      bank: /BRB|Banco de Bras[ií]lia/i.test(text) ? 'BRB' : (grab(text, /^(Banco [^\n−-]+)/m) || ''),
      plan: grab(text, /Plano\s*:\s*([A-Z/]+)/),
      signedAt: textDateISO(grab(text, /Data Assinatura\s*:\s*(\d{1,2}\/[A-Za-z]{3}\/\d{4})/) || ''),
      firstDue: textDateISO(grab(text, /Venc\.?\s*1a\.?\s*Prest\.?\s*:\s*(\d{1,2}\/[A-Za-z]{3}\/\d{4})/) || ''),
      financed: (v => v ? toNum(v) : null)(grab(text, /Valor Financ\.?\s*:\s*([\d.,]+)/)),
      term: (v => v ? Number(v) : null)(grab(text, /Prazo\s*:\s*(\d+)/)),
      rate: (v => v ? Number(v.replace(',', '.')) : null)(grab(text, /Juros\s*:\s*([\d.,]+)\s*%/)),
      index: grab(text, /Ind\.?\s*Reaj\s*:\s*([A-Z]+)/),
      contract: grab(text, /Mutuario:\s*\((\d+)\)/),
      issuedAt: textDateISO(grab(text, /Emitido em\s*([\d]{1,2}\/[A-Za-z]{3}\/\d{4})/) || '')
    };
    const rows = [];
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/^(\d{2}\/\d{2}\/\d{2,4})\s+(\d{1,3})\/(\d{1,3})\s+(.*)$/);
      if (!m) continue;
      const n = Number(m[2]), total = Number(m[3]);
      if (n === 0 || seen.has(n)) continue;              // 000 = assinatura (taxas iniciais)
      const toks = m[4].split(' ').filter(Boolean);
      const nums = toks.filter(t => NUM.test(t)).map(toNum);
      const payDate = toks.find(t => DATE.test(t));
      if (nums.length < 9) continue;
      // A+J, JUROS, AMORT, SEGURO, TAXA, FCVS, FGTS, ENCARGO, SALDO, [VALOR PAGO]
      const [aj, juros, amort, seguro, taxa, , , encargo, saldo] = nums;
      const pago = nums.length >= 10 ? nums[nums.length - 1] : 0;
      const paid = !!payDate && pago > 0;
      seen.add(n);
      rows.push({
        n, total, due: toISO(m[1]),
        amount: paid ? pago : encargo,
        paidAt: paid ? toISO(payDate) : null,
        aj, juros, amort, seguro, taxa, saldo
      });
    }
    rows.sort((a, b) => a.n - b.n);
    if (!rows.length) throw new Error('Não encontrei a tabela de parcelas neste PDF. Confira se é o extrato de evolução do saldo devedor.');
    const last = rows[rows.length - 1];
    contract.lastN = last.n;
    contract.totalCount = last.total;
    contract.projectedFrom = null;
    // Alguns extratos não trazem todas as parcelas. Se ainda há saldo devedor,
    // estimamos as restantes: SAC = amortização constante + juros sobre o saldo.
    if (last.saldo > 0.5 && last.n < last.total) {
      const remaining = last.total - last.n;
      const amort = Math.round(last.saldo / remaining * 100) / 100;
      const r = contract.rate ? contract.rate / 100 / 12 : (last.juros / (last.saldo + last.amort));
      const extra = (last.amount - last.aj - last.seguro - last.taxa);   // FCVS/outros, normalmente 0
      let saldo = last.saldo;
      contract.projectedFrom = last.n + 1;
      for (let k = 1; k <= remaining; k++) {
        const juros = Math.round(saldo * r * 100) / 100;
        const a = k === remaining ? Math.round(saldo * 100) / 100 : amort;
        saldo = Math.max(0, Math.round((saldo - a) * 100) / 100);
        const aj = Math.round((a + juros) * 100) / 100;
        rows.push({ n: last.n + k, total: last.total, due: addMonthsISO(last.due, k), amount: Math.round((aj + last.seguro + last.taxa + Math.max(0, extra)) * 100) / 100,
          paidAt: null, aj, juros, amort: a, seguro: last.seguro, taxa: last.taxa, saldo, projected: true });
      }
    }
    return { contract, rows };
  }

  async function fromFile(file) {
    if (!file || file.size > 15 * 1024 * 1024) throw new Error('Arquivo muito grande (máx. 15 MB).');
    const buf = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...buf.slice(0, 5)) !== '%PDF-') throw new Error('O arquivo não parece ser um PDF.');
    return parse(await extractLines(buf));
  }

  return { parse, extractLines, fromFile, loadPdfJs };
})();
if (typeof module !== 'undefined') module.exports = LoanImport;
