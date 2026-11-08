/**
 * FolioTrack Print & PDF Export Controller
 * Prepares the page for high-resolution vector printing and triggers window.print().
 */

(function () {
  function printReport() {
    // Inject print styles if not already present
    if (!document.getElementById('foliotrack-print-style')) {
      const style = document.createElement('style');
      style.id = 'foliotrack-print-style';
      style.innerHTML = `
        @media print {
          @page {
            size: A4 portrait;
            margin: 8mm 10mm 10mm 10mm;
          }
          body {
            background: #ffffff !important;
            color: #000000 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          #app-sidebar,
          #live-ticker-container,
          nav,
          button,
          select,
          .no-print {
            display: none !important;
          }
          .signature-card {
            box-shadow: none !important;
            border: 1px solid #e5e7eb !important;
            break-inside: avoid !important;
            margin-bottom: 12px !important;
          }
          table {
            width: 100% !important;
            max-width: 100% !important;
            table-layout: fixed !important;
            border-collapse: collapse !important;
          }
          th, td {
            word-wrap: break-word !important;
          }
          canvas {
            max-width: 100% !important;
            height: auto !important;
          }
          #printDisclaimer,
          #printReportFooter {
            display: block !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    window.print();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-action-print-report], #printReportBtn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        printReport();
      });
    });
  });

  window.PdfReport = {
    print: printReport
  };
})();

