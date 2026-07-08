// /seatfromhr and /seathistory. Filtering / sorting / pagination are handled
// by table-tools.js (the 4 filter inputs carry data-col attributes →
// per-column filter mode, same as /driver). This file only wires the
// download button.
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('downloadCsvButton').addEventListener('click', () => {
    fetch('/download-excel-seatfromhr')
      .then(response => {
        if (response.ok) {
          return response.blob();
        }
        throw new Error('Network response was not ok');
      })
      .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'seatfromhr.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
      })
      .catch(error => {
        console.error('Error downloading CSV:', error);
      });
  });
});
