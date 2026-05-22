let id;

let listenerdeletedAdded = false;
let listenereditAdded = false;

function updateid(newid) {

  id = newid

}

const tableBody = document.getElementById('seatTableBody');
const routeInput = document.querySelector('.filter-bar input[placeholder="สายรถ"]');
const dayInput = document.querySelector('.filter-bar input[placeholder="วัน"]');
const boundInput = document.querySelector('.filter-bar input[placeholder="ขา"]');
const timeInput = document.querySelector('.filter-bar input[placeholder="เวลา"]');

document.addEventListener('DOMContentLoaded', async () => {

  // Populate the passenger dropdown in the insert modal.
  // Provided by /js/picker.js.
  await loadPassengerPicker('/passengerusersjson', 'perid');

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

      document.getElementById('insertformModal').style.display = 'block';

    });
  });



  document.getElementById('paxinsertForm').addEventListener('submit', async function (e) {
    e.preventDefault();

    const form = e.target;
    const formData = new FormData(form);

    const requiredFields = ['perid', 'route', 'day', 'bound', 'time', 'bus_number', 'seat_number'];
    let isValid = true;
    requiredFields.forEach(field => {
      if (!formData.get(field)) {
        isValid = false;
        alert(`กรุณากรอกช่อง ${field} ครับ`);
      }else if (formData.get('route') === 'อื่นๆ' && !formData.get('otherroute')) {
        isValid = false;
        alert('Please fill in the other route field.');
      }
    });

    if (!isValid) {
      return;
    }

    const data = {
      perid: formData.get('perid'), 
      route: formData.get('route') === 'อื่นๆ' ? formData.get('otherroute') : formData.get('route'),
      day: formData.get('day'),
      bound: formData.get('bound'),
      time: formData.get('time'), 
      bus_number: formData.get('bus_number'),
      seat_number: formData.get('seat_number') 
    };


    try {
      const response = await fetch('/insertpaxdriver', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (response.ok) {
        alert('เพิ่มผู้โดยสาร สำเร็จครับ');

      } else {
        alert('Error: ' + result.error);
      }
    } catch (error) {
      console.error('Error inserting bus:', error);
      alert('An error occurred while inserting the bus');
    }

    await createtable()

    filterRows()

    document.getElementById('insertformModal').style.display = "none";

  });


  document.getElementById('downloadCsvButton').addEventListener('click', () => {
    fetch('/download-csv-seatdriver')
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
        a.download = 'seatdriver.txt';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
      })
      .catch(error => {
        console.error('Error downloading CSV:', error);
      });
  });

  document.getElementById('route').addEventListener('change', function () {
    var otherRouteRow = document.getElementById('other-route-row');
    if (this.value === 'อื่นๆ') {
      otherRouteRow.style.display = 'flex';
    } else {
      otherRouteRow.style.display = 'none';
    }

  });

  document.getElementById('editroute').addEventListener('change', function () {
    var otherRouteRow = document.getElementById('edit-other-route-row');
    if (this.value === 'อื่นๆ') {
      otherRouteRow.style.display = 'flex';
    } else {
      otherRouteRow.style.display = 'none';
    }

  });


});

async function fetchseatData() {
  try {
    const response = await fetch('/seatdriverjson');
    const data = await response.json();
    return data.rows;

  } catch (error) {
    console.error('Error fetching bus data:', error);
  }
}

async function createtable() {

  let data = await fetchseatData();

  const tableBody = document.getElementById('seatTableBody');

  tableBody.innerHTML = ''

  data.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${row.perid}</td>
      <td>${row.first_name} ${row.last_name}</td>
      <td>${row.route}</td>
      <td>${row.location}</td>
      <td>${row.day}</td>
      <td>${row.bound}</td>
      <td>${row.time}</td>
      <td>${row.busnumber}</td>
      <td>${row.seat}</td>
      <td class="edit-btn" data-userid="${row.id}">✏️</td>
      <td class="delete-btn" data-userid="${row.id}">🗑️</td>
    `;

    tableBody.appendChild(tr);
  });


  const deleteButtons = document.querySelectorAll('.delete-btn');
  const editButtons = document.querySelectorAll('.edit-btn');

  const deletemodal = document.getElementById('deleteModal');
  const editformmodal = document.getElementById('editformModal');
  const confirmYesBtn = document.getElementById('confirm-yes');
  const confirmNoBtn = document.getElementById('confirm-no');


  let span = document.getElementsByClassName("close")[0];

  let span2 = document.getElementsByClassName("close")[1];

  span.onclick = function () {
    document.getElementById('insertformModal').style.display = "none";
  }

  span2.onclick = function () {
    document.getElementById('editformModal').style.display = "none";
  }


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

        const response = await fetch('/removepaxdriver', {
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




  if (!listenereditAdded) {
    document.getElementById('paxEditForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const editformmodal = document.getElementById('editformModal');

      const form = e.target;
      const formData = new FormData(form);
      const data = {
        id: id,
        route: formData.get('editroute') === 'อื่นๆ' ? formData.get('editotherroute') : formData.get('editroute'),
        bus_number: formData.get('bus_number'),
        seat_number: formData.get('seat_number')

      };

      try {
        const response = await fetch('/editpaxdriver', {
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



const renderRows = (rows) => {

  const resultsDisplay = document.querySelector('.results span');
  const totalRows = tableBody.querySelectorAll('tr').length;

  rows.forEach((row, index) => {
    row.style.display = '';
  });

  resultsDisplay.textContent = `${totalRows} Result(s)`;

};

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

  renderRows(newrow);
};
