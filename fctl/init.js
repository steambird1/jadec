const physics = require("../physics/jade-chamber");

// Initialize Jade Chamber object for further use.
function loadJadeChamber() {
	return new physics.JadeChamber({
		a: 160, b: 160, c: 80
	});
}

module.exports = {loadJadeChamber};
