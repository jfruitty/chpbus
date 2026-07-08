// /thisweekdashboard and /nextweekdashboard. Filtering / sorting / pagination
// are handled by table-tools.js (unified search box + the data-filter grid
// filters สายรถ/วัน/ขา/เวลา). This file keeps only the page-specific parts:
//   - department/HR approval dropdowns → POST updates (thisweekdashboard)
//   - colour-coding the approval <select> by its value
//   - double-click a column header to hide that column
document.addEventListener('DOMContentLoaded', () => {
  const tableBody = document.querySelector('.approval-table tbody');

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
    } else if (event.target.classList.contains('approval-hr-thisweek')) {
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
    header.addEventListener('dblclick', function () {
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
