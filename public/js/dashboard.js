document.addEventListener('DOMContentLoaded', () => {
  // Elements

  const perInput = document.querySelector('.filter-bar input[placeholder="เลขประจำตัว"]');
  const nameInput = document.querySelector('.filter-bar input[placeholder="ชื่อ"]');
  const deptSelect = document.querySelector('.filter-bar select.dept-filter');
  const tableBody = document.querySelector('.approval-table tbody');
  const prevPageButton = document.querySelector('.pagination .prev-page');
  const nextPageButton = document.querySelector('.pagination .next-page');
  const pageDisplay = document.querySelector('.pagination span');
  const resultsDisplay = document.querySelector('.results span');


  let currentPage = 1;
  const rowsPerPage = 10;
  let totalRows = tableBody.querySelectorAll('tr').length;
  let totalPages = Math.ceil(totalRows / rowsPerPage);

  let rows = tableBody.querySelectorAll('tr');

  // Function to render rows based on the current page
  const renderRows = () => {
    rows.forEach((row, index) => {
      row.style.display = (index >= (currentPage - 1) * rowsPerPage && index < currentPage * rowsPerPage) ? '' : 'none';
    });
    pageDisplay.textContent = `${currentPage}/${totalPages} Pages`;
    resultsDisplay.textContent = `${totalRows} Result(s)`;
  };

  // Initial render
  renderRows();

  // Pagination
  prevPageButton.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderRows();
    }
  });

  nextPageButton.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      renderRows();
    }
  });

  // Filter and Search — matches employee id, name (first + last) and department.
  const filterRows = () => {
    const perTerm = perInput.value.trim().toLowerCase();
    const nameTerm = nameInput.value.trim().toLowerCase();
    const deptTerm = deptSelect ? deptSelect.value : '';

    const allRows = tableBody.querySelectorAll('tr');
    const matched = [];

    allRows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      const perValue = cells[1] ? cells[1].textContent.toLowerCase() : '';
      const nameValue = ((cells[2] ? cells[2].textContent : '') + ' ' +
                         (cells[3] ? cells[3].textContent : '')).toLowerCase();
      const deptValue = row.dataset.department || '';

      const matchesPerNumber = perTerm === '' || perValue.includes(perTerm);
      const matchesName = nameTerm === '' || nameValue.includes(nameTerm);
      const matchesDept = deptTerm === '' || deptValue === deptTerm;

      if (matchesPerNumber && matchesName && matchesDept) {
        matched.push(row);
      } else {
        row.style.display = 'none';
      }
    });

    totalRows = matched.length;
    totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
    currentPage = 1;
    rows = matched;
    renderRows();
  };

  nameInput.addEventListener('input', filterRows);
  perInput.addEventListener('input', filterRows);
  if (deptSelect) deptSelect.addEventListener('change', filterRows);

  tableBody.addEventListener('change', async (event) => {
    if (event.target.classList.contains('approval-department-thisweek')) {
      const select = event.target;
      const status = select.value;
      const userId = select.closest('tr').dataset.userid;

      try {
        const response = await fetch(`/update-approval-department-thisweek`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId, status }),
        });

        if (response.ok) {
          console.log('Approval status updated successfully');
        } else {
          console.error('Failed to update approval status');
        }
      } catch (error) {
        console.error('Error:', error);
      }
    }else if(event.target.classList.contains('approval-hr-thisweek')){

      const select = event.target;
      const status = select.value;
      const userId = select.closest('tr').dataset.userid;

      try {
        const response = await fetch(`/update-approval-hr-thisweek`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId, status }),
        });

        if (response.ok) {
          console.log('Approval status updated successfully');
        } else {
          console.error('Failed to update approval status');
        }
      } catch (error) {
        console.error('Error:', error);
      }


    }
  });

  var approvalStatusSelects = document.querySelectorAll('select.approval-department-thisweek');

  function updateSelectClass(selectElement) {
    selectElement.className = 'approval-department-thisweek ' + selectElement.value;
  }

  // Update class initially for each select element
  approvalStatusSelects.forEach(function (selectElement) {
    updateSelectClass(selectElement);
  });

  // Add event listener to update class on change for each select element
  approvalStatusSelects.forEach(function (selectElement) {
    selectElement.addEventListener('change', function () {
      updateSelectClass(selectElement);
    });
  });

  var approvalHrStatusSelects = document.querySelectorAll('select.approval-hr-thisweek');

  function updateSelecthrClass(selectElement) {
    selectElement.className = 'approval-hr-thisweek ' + selectElement.value;
  }

  // Update class initially for each select element
  approvalHrStatusSelects.forEach(function (selectElement) {
    updateSelecthrClass(selectElement);
  });

  // Add event listener to update class on change for each select element
  approvalHrStatusSelects.forEach(function (selectElement) {
    selectElement.addEventListener('change', function () {
      updateSelecthrClass(selectElement);
    });
  });



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
