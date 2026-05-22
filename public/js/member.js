document.addEventListener('DOMContentLoaded', () => {
  // Elements

  const perInput = document.querySelector('.filter-bar input[placeholder="เลขประจำตัว"]');
  const nameInput = document.querySelector('.filter-bar input[placeholder="ชื่อ"]');
  const selectDepartment = document.querySelector('.select-department');
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

  // Filter and Search
  const filterRows = () => {
    const perTerm = perInput.value.toLowerCase();
    const nameTerm = nameInput.value.toLowerCase();
    const departmentTerm = selectDepartment.value.toLowerCase();

    totalRows = 0;
    let newrow = []
    const allrows = tableBody.querySelectorAll('tr');

    allrows.forEach(row => {
      const cells = row.querySelectorAll('td');
      const perInput = cells[1].textContent.toLowerCase();
      const nameInput = cells[3].textContent.toLowerCase();
      const deptSelect = cells[5].querySelector('select.user-department');
      const selectDepartment = (deptSelect ? deptSelect.value : cells[5].textContent).toLowerCase();

      allrows.forEach((row) => {
        row.style.display = 'none';
      });

      const matchesPerNumber = perTerm === '' || perInput.includes(perTerm)
      const matchesName = nameTerm === '' || nameInput.includes(nameTerm)
      const matchesDepartment = departmentTerm === '' || selectDepartment.includes(departmentTerm)
      if (matchesName && matchesPerNumber && matchesDepartment) {

        newrow.push(row)
        totalRows++;
      }
    });

    totalPages = Math.ceil(totalRows / rowsPerPage);
    currentPage = 1;
    rows = newrow
    renderRows();
  };

  nameInput.addEventListener('input', filterRows);
  perInput.addEventListener('input', filterRows);
  selectDepartment.addEventListener('change', filterRows);

  tableBody.addEventListener('change', async (event) => {
    if (event.target.classList.contains('approval-status')) {
      const select = event.target;
      const status = select.value;
      const userId = select.closest('tr').dataset.userid;

      try {
        const response = await fetch(`/update-approval-status`, {
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

    if (event.target.classList.contains('user-department')) {
      const select = event.target;
      const department = select.value;
      const userId = select.closest('tr').dataset.userid;

      try {
        const response = await fetch(`/update-user-department`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId, department }),
        });

        if (response.ok) {
          console.log('User department updated successfully');
        } else {
          console.error('Failed to update user department');
        }
      } catch (error) {
        console.error('Error:', error);
      }
    }
  });

  var approvalStatusSelects = document.querySelectorAll('select.approval-status');

  function updateSelectClass(selectElement) {
    selectElement.className = 'approval-status ' + selectElement.value;
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
