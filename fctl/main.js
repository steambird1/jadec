const physics = require("../physics/jade-chamber");

/*
Jade Chamber flight controls

Released by Jade Chamber Development Corp., 2003 - 2025,
published under GPLv3.

Last written by Seabird Starch Gunnhildr
*/

// All these requires a jade chamber object


/**
 * @interface
 */
class Component {
	getSystemStatus() {
		return {
			status: "ok"
		};
	}
}

/**
 * @typedef {"none" | "lvl" | "cws"} pitchAttControl
 * @typedef {"none" | "lvl" | "cws"} rollAttControl
 * 'terr' mode means terrain escape
 * @typedef {"none" | "vs" | "capt" | "hold" | "terr"} altControl
 * @typedef {"none" | "hdg" | "loc" | "nav"} yawControl
 * @typedef {"none" | "spd" | "nav"} surgeControl
 * @typedef {"none" | "spd" | "nav"} swayControl
 */

// Component 1: engine controls

/**
 * @typedef {{
 * 	x: number;
 *  v: number;
 *  x_err: number?;
 *  v_err: number?;
 * }} _DirectedMotion
 * @typedef {{
 * 	x: _DirectedMotion;
 *  y: _DirectedMotion;
 *  z: _DirectedMotion
 * }} NavigationStatus
 */
/**
 * @implements {Component}
 * @interface
 */
class NavigationSource {
	/**
	 * 
	 * @param {NavigationStatus} status 
	 */
	updateStatus(status) {

	}

	updateConfig(config) {

	}

	/**
	 * @returns {number | { direction: number; speed: number; }} The angle (0 to 360) or speed (m/s), or `null` if no need to change.
	 */
	evaluate() {
		return null;
	}

	/**
	 * 
	 * @returns If the status of the returns is "standby", the autopilot will only allow the
	 * navigation to be in standby status, with a natural fallback to HOLD (if alt control), HDG (if yaw)
	 * and SPD (if surge/sway).
	 *
	 * Otherwise, if not "ok" (e.g. "failed"), autopilot will be disengage itself if relevant
	 * navigation is set.
	 */
	getSystemStatus() {
		return {
			status: "standby"
		};
	}
}

const AutopilotFailures = {
	ConfigError: {
		yaw: 1,
		surge: 2
	}
};

/**
 * Autopilot controller.
 * 
 * The autopilot logic is:
 * [CWS Mode] | [Altitude Mode] | [Navigation Mode] | [Autopilot Gross]
 * 
 * @implements {Component}
 */
class Autopilot {

	/**
	 *
	 * @param {physics.JadeChamber} jadec
	 */
	constructor(jadec) {
		/**
		 * @type {physics.JadeChamber}
		 */
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
		 * @type {surgeControl}
		 */
		this.surgeMode = "none";
		/**
		 * @type {{
		 * pitch: number?;
		 * roll: number?;
		 * alt: NavigationSource;
		 * yaw: NavigationSource;
		 * surge: NavigationSource;
		 * }}
		 */
		this.targets = {
			pitch: null,
			roll: null,
			alt: new NavigationSource(),
			yaw: new NavigationSource(),
			surge: new NavigationSource()
		};
	}

	getApStatus() {
		return { 
			pitchNode: this.pitchMode, 
			rollMode: this.rollMode, 
			altMode: this.altMode, 
			yawMode: this.yawMode, 
			surgeMode: this.surgeMode };
	}

	/**
	 * 
	 * @param {"pitch" | "roll" | "alt" | "yaw" | "surge"} category 
	 * @param {string} value 
	 */
	setApStatus(category, value) {
		const ACCEPTED = ["pitch" , "roll" , "alt" , "yaw" , "surge"];
		if (ACCEPTED.indexOf(category) !== -1) {
			this[`${category}Mode`] = value;
		}
	}


	/**
	 * @typedef {{
	 * pitch: number?;
	 * roll: number?;
	 * alt: {target: number; vs: number;}?;
	 * yaw: number?;
	 * surge: {direction: number; speed: number;}?;
	 * fault: 0;
	 * }} _DirectAPStatus
	 */
	/**
	 * Get the actual instruction of configuration.
	 * 
	 * @return {_DirectAPStatus}
	 */
	getCommand() {
		const altObject = this.targets.alt;
		const yawObject = this.targets.yaw;
		const surgeObject = this.targets.surge;
		/**
		 * @type {_DirectAPStatus}
		 */
		const result = {
			pitch: this.targets.pitch,
			roll: this.targets.roll
		};
		
	}

	/**
	 * Get autopilot system status
	 */
	getSystemStatus() {
		return {
			status: "ok"
		};
	}

	/**
	 * @typedef {{ current: string?, armed: string? }} _FMASingleStatus
	 * @typedef {{ att: _FMASingleStatus; alt: _FMASingleStatus; spd: _FMASingleStatus; ap: string[];  }} _FMAStatus
	 */
	/**
	 * @returns {_FMAStatus}
	 */
	getFmaStatus() {

	}

	/**
	 * Execute once in the main loop.
	 */
	run() {

	}

}

// Component 2: navigation and relevant management
// This is directly related to autopilot.


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
