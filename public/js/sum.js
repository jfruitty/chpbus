document.addEventListener('DOMContentLoaded', () => {
  

  /// function to hide column when double click on th
    const table = document.querySelector('.approval-table');
 
    const headers = table.querySelectorAll('th');

    headers.forEach((header, index) => {
      header.addEventListener('dblclick', function() {
        hideColumn(index);
      });
    });

    function hideColumn(index) {
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('th, td');
        if (cells[index]) {
          cells[index].style.display = 'none';
        }
      });
    }


});
