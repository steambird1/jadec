const physics = require("../physics/jade-chamber");

/*
Jade Chamber flight controls

Released by Jade Chamber Development Corp., 2003 - 2025, under GPLv3.

Last written by Seabird Starch Gunnhildr
*/

// All these requires a jade chamber object

/**
 * @typedef {"none" | "cws"} pitchAttControl
 * @typedef {"none" | "cws"} rollAttControl
 * 'terr' mode means terrain escape
 * @typedef {"none" | "vs" | "hold" | "terr"} altControl
 * @typedef {"none" | "hdg" | "loc" | "nav"} yawControl
 * @typedef {"none" | "spd" | "nav"} surgeControl
 * @typedef {"none" | "spd" | "nav"} swayControl
 * @typedef {"none" | "spd"} spdControl
 */

// Component 1: engine controls

class Autopilot {

	/**
 *
 * @param {physics.JadeChamber} jadec
 */
	constructor(jadec) {
		this.jadec = jadec;
		/**
 * @type {pitchAttControl}
 */
		this.pitchMode = "none";
		/**
 * @type {rollAttControl}
 */
		this.rollMode = "none";
		/**
 * @type {altControl}
 */
		this.altMode = "none";
		/**
 * @type {yawControl}
 */
		this.yawMode = "none";
		/**
 * @type {}
 */
		this.surgeMode = "none";
		this.swayMode = "none";
		this.spdMode = "none";
	}


}

// Component 2: navigation and relevant management

// Component 3: energy control
// 3-1. Geo-element trasmission
// 3-2. APU (from traditional fuel) with electro. generation
// Assume that engines support geo & electro [exactly one for a particular period, not simultaneously]
// 3-3. Energy for equip
// 3-4. Energy for chamber devices

// Component 4: Bleeding and air cond (by geo and one electro backup)

// Component 5: Fire extinguisher (INCLUDING THUNDER)

// Component 6: Water control (INCLUDING RAIN)

// Component 7: Floating stones

// Component 8: Supplies

// Component 9: Evacuation
