let id;

let listenerdeletedAdded = false;
let listenereditAdded = false;

function updateid(newid) {

  id = newid

}

const tableBody = document.getElementById('busTableBody');
const routeInput = document.querySelector('.filter-bar input[placeholder="สายรถ"]');
const dayInput = document.querySelector('.filter-bar input[placeholder="วัน"]');
const boundInput = document.querySelector('.filter-bar input[placeholder="ขา"]');
const timeInput = document.querySelector('.filter-bar input[placeholder="เวลา"]');


document.addEventListener('DOMContentLoaded', async () => {

  // Populate the driver dropdowns in both the insert and edit modals.
  // Provided by /js/picker.js.
  await loadDriverPicker('/driverusersjson', ['name', 'insertname']);

  await createtable();

  let rows = tableBody.querySelectorAll('tr');
  renderRows(rows);


  dayInput.addEventListener('input', filterRows);
  routeInput.addEventListener('input', filterRows);
  boundInput.addEventListener('input', filterRows);
  timeInput.addEventListener('input', filterRows);

  const addButtons = document.querySelectorAll('.add-btn');

  addButtons.forEach(button => {
    button.addEventListener('click', function () {

      insertformModal.style.display = 'block';

    });
  });

  document.getElementById('businsertForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const insertformmodal = document.getElementById('insertformModal');

    const form = e.target;
    const formData = new FormData(form);

    const requiredFields = ['insertname', 'route', 'day', 'bound', 'time', 'bus_number'];
    let isValid = true;
    requiredFields.forEach(field => {
      if (!formData.get(field)) {
        isValid = false;
        alert(`Please fill in the ${field} field.`);
      } else if (formData.get('route') === 'อื่นๆ' && !formData.get('otherroute')) {
        isValid = false;
        alert('Please fill in the other route field.');
      }
    });



    if (!isValid) {
      return;
    }

    // readPickerSelection (from picker.js) returns
    // { perid, driver_user_id, first_name, last_name } as null-or-string.
    const data = {
      name: formData.get('insertname'),
      ...readPickerSelection('insertname'),
      route: formData.get('route') === 'อื่นๆ' ? formData.get('otherroute') : formData.get('route'),
      day: formData.get('day'),
      bound: formData.get('bound'),
      time: formData.get('time'),
      bus_number: formData.get('bus_number'),
    };


    try {
      const response = await fetch('/insertbustoday', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (response.ok) {
        alert('Bus inserted successfully');
      } else {
        alert('Error: ' + result.error);
      }
    } catch (error) {
      console.error('Error inserting bus:', error);
      alert('An error occurred while inserting the bus');
    }

    await createtable()

    filterRows()

    insertformmodal.style.display = "none";


  });

  const sendbutton = document.getElementById('send-btn');
  const sendbuttonLabel = sendbutton.textContent;
  let sending = false;

  function resetSendButton() {
    sending = false;
    sendbutton.disabled = false;
    sendbutton.textContent = sendbuttonLabel;
  }

  sendbutton.addEventListener('click', function () {
    // Ignore repeat clicks while a send is in flight. The send pushes one LINE
    // message per driver + per passenger (can take 10-30s), so without this the
    // button looks "frozen" and users press again — which used to wipe the data.
    if (sending) return;
    sending = true;
    sendbutton.disabled = true;
    sendbutton.textContent = '⏳ กำลังส่ง... อย่าปิดหน้านี้';

    fetch('/sendmsgtodriver', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    })
      .then(async response => {
        if (response.ok) {
          alert('ส่งข้อความถึงผู้ใช้สำเร็จ');
          window.location.reload(); // leave the button disabled until reload
          return;
        }
        // Not ok (e.g. 409 "ไม่มีข้อมูลให้ส่ง") — show the server message, allow retry.
        let msg = 'ส่งไม่สำเร็จ กรุณาลองใหม่';
        try { const r = await response.json(); if (r && r.error) msg = r.error; } catch (e) { /* ignore */ }
        alert(msg);
        resetSendButton();
      })
      .catch(error => {
        console.error('sendmsgtodriver failed:', error);
        alert('เกิดข้อผิดพลาดระหว่างส่งข้อความ กรุณาลองใหม่');
        resetSendButton();
      });
  });

  document.getElementById('downloadCsvButton').addEventListener('click', () => {
    fetch('/download-excel-bustoday')
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
        a.download = 'bustoday.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
      })
      .catch(error => {
        console.error('Error downloading CSV:', error);
      });
  });



  document.getElementById('route').addEventListener('change', function() {
    var otherRouteRow = document.getElementById('other-route-row');
    if (this.value === 'อื่นๆ') {
        otherRouteRow.style.display = 'flex';
    } else {
        otherRouteRow.style.display = 'none';
    }

});

document.getElementById('editroute').addEventListener('change', function() {
  var otherRouteRow = document.getElementById('edit-other-route-row');
  if (this.value === 'อื่นๆ') {
      otherRouteRow.style.display = 'flex';
  } else {
      otherRouteRow.style.display = 'none';
  }

});



});

async function fetchBusData() {
  try {
    const response = await fetch('/bustodayjson');
    const data = await response.json();
    return data.rows;

  } catch (error) {
    console.error('Error fetching bus data:', error);
  }
}

const renderRows = (rows) => {

  const resultsDisplay = document.querySelector('.results span');
  const totalRows = tableBody.querySelectorAll('tr').length;

  rows.forEach((row, index) => {
    row.style.display = '';
  });

  resultsDisplay.textContent = `Total ${totalRows} Result(s)`;

};

async function createtable() {

  let data = await fetchBusData();

  const tableBody = document.getElementById('busTableBody');

  tableBody.innerHTML = ''

  let totalCost = 0;

  data.forEach((row, index) => {
    const cost = calculateCost(row.route);
    totalCost += cost;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${row.perid}</td>
      <td>${row.first_name} ${row.last_name}</td>
      <td>${row.route}</td>
      <td>${row.day}</td>
      <td>${row.bound}</td>
      <td>${row.time}</td>
      <td>${row.number}</td>
      <td>${row.pax}</td>
      <td class="edit-btn" data-userid="${row.id}">✏️</td>
      <td class="delete-btn" data-userid="${row.id}">🗑️</td>
    `;

    tableBody.appendChild(tr);
  });


  const costDisplay = document.querySelector('.cost span');
  costDisplay.textContent = `รวมค่าใช้จ่าย ${totalCost}`;


  const deleteButtons = document.querySelectorAll('.delete-btn');
  const editButtons = document.querySelectorAll('.edit-btn');

  const deletemodal = document.getElementById('deleteModal');
  const editformmodal = document.getElementById('editformModal');
  const confirmYesBtn = document.getElementById('confirm-yes');
  const confirmNoBtn = document.getElementById('confirm-no');

  const insertformModal = document.getElementById('insertformModal');

  deleteButtons.forEach(button => {
    button.addEventListener('click', function () {

      deletemodal.style.display = 'block';

      updateid(button.dataset.userid)

      console.log("button ->" + id)

    });
  });

  if (!listenerdeletedAdded) {
    confirmYesBtn.addEventListener('click', async function () {

      try {
        deletemodal.style.display = 'none';

        console.log("todeleted ->" + id)

        const response = await fetch('/removebustoday', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });

        if (response.ok) {
          alert('ลบรถสำเร็จ');
        } else {
          throw new Error('Server responded with an error');
        }

        await createtable()

        filterRows()

        deletemodal.style.display = 'none';

      } catch (error) {
        console.error('Error removing bus:', error);
        alert('An error occurred while removing the bus.');
      }
    });

    listenerdeletedAdded = true;
  }

  confirmNoBtn.addEventListener('click', function () {

    deletemodal.style.display = 'none';

  });


  editButtons.forEach(button => {
    button.addEventListener('click', function () {

      editformmodal.style.display = 'block';

      id = button.dataset.userid;

    });
  });



  let span = document.getElementsByClassName("close")[0];

  let span2 = document.getElementsByClassName("close")[1];

  span.onclick = function () {
    editformmodal.style.display = "none";
  }

  span2.onclick = function () {
    insertformModal.style.display = "none";
  }


  if (!listenereditAdded) {
    document.getElementById('busEditForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const editformmodal = document.getElementById('editformModal');

      const form = e.target;
      const formData = new FormData(form);
      const data = {
        id: id,
        name: formData.get('name'),
        ...readPickerSelection('name'),
        route: formData.get('editroute') === 'อื่นๆ' ? formData.get('editotherroute') : formData.get('editroute'),
      };


      try {
        const response = await fetch('/editbustoday', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        });

        const result = await response.json();

        if (response.ok) {
          alert('Bus edit successfully');
        } else {
          alert('Error: ' + result.error);
        }
      } catch (error) {
        console.error('Error inserting bus:', error);
        alert('An error occurred while inserting the bus');
      }

      await createtable()
      filterRows()
      
      editformmodal.style.display = "none";


    });

    listenereditAdded = true

    }

    document.querySelector('#editformModal .close').addEventListener('click', function () {
      const editformmodal = document.getElementById('editformModal');
      editformmodal.style.display = "none";
    });



  }

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
      const dayInput = cells[4].textContent.toLowerCase();
      const boundInput = cells[5].textContent.toLowerCase();
      const timeInput = cells[6].textContent.toLowerCase();

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

    renderRows(newrow);
  };


  function calculateCost(route) {
    const routeCosts = {
      'สุวินทวงค์': 933,
      'ศรีโสธร': 695,
      'แหล่มประดู่': 595,
      'บางคล้า(หัวไทร)': 583,
      'บางคล้า(หนองครก)': 575,
      'บางคล้า(วังเย็น)': 498,
      'พนมดงน้อย': 566,
      'สนามชัย': 724,
      'หนองแหน': 536
    };
  
    for (const [routeName, cost] of Object.entries(routeCosts)) {
      if (route.includes(routeName)) {
        return cost;
      }
    }
  
    return 0; 
  }
