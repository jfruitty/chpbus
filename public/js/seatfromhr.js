document.addEventListener('DOMContentLoaded', () => {
  // Elements

  const routeInput = document.querySelector('.filter-bar input[placeholder="สายรถ"]');
  const dayInput = document.querySelector('.filter-bar input[placeholder="วัน"]');
  const boundInput = document.querySelector('.filter-bar input[placeholder="ขา"]');
  const timeInput = document.querySelector('.filter-bar input[placeholder="เวลา"]');

  const tableBody = document.querySelector('.approval-table tbody');

  const resultsDisplay = document.querySelector('.results span');

  let totalRows = tableBody.querySelectorAll('tr').length;
  resultsDisplay.textContent = `${totalRows} Result(s)`;

  let rows = tableBody.querySelectorAll('tr');

  const renderRows = () => {
    rows.forEach((row, index) => {
      row.style.display = '';
    });
    resultsDisplay.textContent = `${totalRows} Result(s)`;
  };

  // Initial render
  renderRows();

  // Filter and Search
  const filterRows = () => {
    const routeTerm = routeInput.value.toLowerCase();
    const dayTerm = dayInput.value.toLowerCase();
    const boundTerm = boundInput.value.toLowerCase();
    const timeTerm = timeInput.value.toLowerCase();

    totalRows = 0;
    let newrow = []
    const allrows = tableBody.querySelectorAll('tr');

    allrows.forEach(row => {
      const cells = row.querySelectorAll('td');
      const routeInput = cells[3].textContent.toLowerCase();
      const dayInput = cells[5].textContent.toLowerCase();
      const boundInput = cells[6].textContent.toLowerCase();
      const timeInput = cells[7].textContent.toLowerCase();

      allrows.forEach((row) => {
        row.style.display = 'none';
      });

      const matchesRoute = routeTerm === '' || routeInput.includes(routeTerm)
      const matchesDay = dayTerm === '' || dayInput.includes(dayTerm)
      const matchesBound = boundTerm === '' || boundInput.includes(boundTerm)
      const matchesTime = timeTerm === '' || timeInput.includes(timeTerm)

      if (matchesRoute && matchesDay && matchesBound && matchesTime) {

        newrow.push(row)
        totalRows++;
      }
    });

    rows = newrow
    renderRows();
  };


  dayInput.addEventListener('input', filterRows);
  routeInput.addEventListener('input', filterRows);
  boundInput.addEventListener('input', filterRows);
  timeInput.addEventListener('input', filterRows);

  

  document.getElementById('downloadCsvButton').addEventListener('click', () => {
    fetch('/download-csv-seatfromhr')
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
        a.download = 'seatfromhr.txt';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
      })
      .catch(error => {
        console.error('Error downloading CSV:', error);
      });
  });

});
