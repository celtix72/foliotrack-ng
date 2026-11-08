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
            margin: 10mm 12mm 12mm 12mm;
          }
          html,
          body {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            overflow-x: visible !important;
            overflow-y: visible !important;
            display: block !important;
            position: static !important;
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
          .flex-1,
          .overflow-y-auto,
          .overflow-x-hidden,
          .overflow-hidden,
          .overflow-x-auto,
          main,
          #printableReportArea,
          #reportContent,
          #portfoliosContainer {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
            overflow-x: visible !important;
            overflow-y: visible !important;
            display: block !important;
            position: static !important;
            float: none !important;
            width: 100% !important;
            max-width: 100% !important;
          }
          .signature-card {
            box-shadow: none !important;
            border: 1px solid #e5e7eb !important;
            background: #ffffff !important;
            margin-bottom: 12px !important;
          }
          .portfolio-report-card {
            box-shadow: none !important;
            border: 1px solid #e5e7eb !important;
            background: #ffffff !important;
            break-inside: auto !important;
            page-break-inside: auto !important;
            margin-bottom: 16px !important;
          }
          table {
            width: 100% !important;
            max-width: 100% !important;
            table-layout: fixed !important;
            border-collapse: collapse !important;
            page-break-inside: auto !important;
            break-inside: auto !important;
          }
          thead {
            display: table-header-group !important;
          }
          tfoot {
            display: table-footer-group !important;
          }
          tr {
            page-break-inside: avoid !important;
            break-inside: avoid !important;
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
            page-break-inside: avoid !important;
            break-inside: avoid !important;
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

