'use strict';

(function () {

  function Myo($rootScope, $window, $timeout, MyoOptions, MyoOrientation) {
    var self = this;

    var instanceOptions = {};
    var devices = new Map();
    var eventsByDevice = new Map();
    var lockTimeouts = new Map();

    /************************************** Getters ***************************************/
    this.getDevice = function (deviceID) {
      return devices.get(deviceID);
    };

    this.getEventsForDevice = function (deviceID) {
      return eventsByDevice.get(deviceID);
    };

    this.getOptions = function () {
      return instanceOptions;
    };

    /************************************** helpers ***************************************/
    /**
     * Test if orientation request should be skipped.
     *
     * ngMyo skip the request if the instanceOptions.skipOneOrientationEvery option is defined and the request number is n * instanceOptions.skipOneOrientationEvery
     * ex : instanceOptions.skipOneOrientationEvery = 2, ngMyo will skip 1 request every 2 requests
     *
     * @param device - the {@link MyoDevice}
     * @returns {skipOneOrientationEvery|*|boolean} - truthy if request should be skipped
     */
    var shouldSkipOrientation = function (device) {
      var requestNb = device.incrementOrientationRequest();
      return instanceOptions.skipOneOrientationEvery && requestNb % instanceOptions.skipOneOrientationEvery === 0;
    };

    /**
     * Test if variable is integer
     *
     * @param variable - the value du test
     * @returns {boolean} - true if variable is an integer
     */
    var isInteger = function (variable) {
      return typeof variable === 'number' && (variable % 1) === 0;
    };

    /**
     * Call angular digest if not already in progress
     */
    var safeDigest = function () {
      if (instanceOptions.autoApply && !$rootScope.$$phase) {
        $rootScope.$digest();
      }
    };

    /*************************************** Events listeners ****************************************/
    /**
     *
     * @param eventName - 'armRecognized' | 'armLost' | 'thumb_to_pinky' | 'fingers_spread' | 'wave_in' | 'wave_out' | 'fist' | 'emg'
     * @param fn - callback function taking a {@link MyoDevice} as argument
     * @param deviceId - Myo device id. If undefined, this callback will be attached to myo device 0
     */
    this.on = function (eventName, fn, deviceId) {
      if (!deviceId) {
        deviceId = 0;
      }

      var fnsByEvent = eventsByDevice.get(deviceId) || new Map();
      var fns = fnsByEvent.get(eventName) || [];
      fns.push(fn);

      fnsByEvent.set(eventName, fns);
      eventsByDevice.set(deviceId, fnsByEvent);

      return self;
    };

    /************************************** start with options ***************************************/
    /**
     * Define ngMyo options and initialize websocket listeners
     * @param customOptions - user options. If not defined, ngMyo will take default options
     */
    this.start = function (customOptions) {
      initOptions(customOptions);
      initWebSocket();
      return self;
    };

    /**
     * Initialize options combining custom options and default options
     * @param customOptions - user options. If not defined, ngMyo will take default options
     */
    var initOptions = function (customOptions) {
      if (customOptions) {
        instanceOptions.wsUrl = customOptions.wsUrl !== undefined ? customOptions.wsUrl : MyoOptions.wsUrl;
        instanceOptions.apiVersion = customOptions.apiVersion !== undefined ? customOptions.apiVersion : MyoOptions.apiVersion;
        instanceOptions.autoApply = customOptions.autoApply !== undefined ? customOptions.autoApply : MyoOptions.autoApply;
        instanceOptions.timeBeforeReconnect = isInteger(customOptions.timeBeforeReconnect) ? customOptions.timeBeforeReconnect : MyoOptions.timeBeforeReconnect;
        instanceOptions.useRollPitchYaw = customOptions.useRollPitchYaw !== undefined ? customOptions.useRollPitchYaw : MyoOptions.useRollPitchYaw;
        instanceOptions.rollPitchYawScale = customOptions.rollPitchYawScale !== undefined ? customOptions.rollPitchYawScale : MyoOptions.rollPitchYawScale;
        instanceOptions.broadcastOnConnected = customOptions.broadcastOnConnected !== undefined ? customOptions.broadcastOnConnected : MyoOptions.broadcastOnConnected;
        instanceOptions.broadcastOnDisconnected = customOptions.broadcastOnDisconnected !== undefined ? customOptions.broadcastOnDisconnected : MyoOptions.broadcastOnDisconnected;
        instanceOptions.broadcastOnLockUnlock = customOptions.broadcastOnLockUnlock !== undefined ? customOptions.broadcastOnLockUnlock : MyoOptions.broadcastOnLockUnlock;
        instanceOptions.skipOneOrientationEvery = isInteger(customOptions.skipOneOrientationEvery) ? customOptions.skipOneOrientationEvery : MyoOptions.skipOneOrientationEvery;
        instanceOptions.lockUnlockPose = customOptions.lockUnlockPose !== undefined ? customOptions.lockUnlockPose : MyoOptions.lockUnlockPose;
        instanceOptions.lockUnlockPoseTime = isInteger(customOptions.lockUnlockPoseTime) ? customOptions.lockUnlockPoseTime : MyoOptions.lockUnlockPoseTime;
        instanceOptions.poseTime = isInteger(customOptions.poseTime) ? customOptions.poseTime : MyoOptions.poseTime;
      }
      else {
        instanceOptions = MyoOptions;
      }
    };

    /**
     * Initialize websocket and listeners
     */
    var initWebSocket = function () {
      if (!$window.WebSocket) {
        throw new Error('Socket not supported by browser');
      }

      var ws = new $window.WebSocket(instanceOptions.wsUrl + instanceOptions.apiVersion);

      ws.onopen = function () {
        $rootScope.$broadcast('ngMyoStarted');
        safeDigest();
      };

      ws.onclose = function () {
        $rootScope.$broadcast('ngMyoClosed');
        safeDigest();
        $timeout(function () {
          initWebSocket();
        }, instanceOptions.timeBeforeReconnect);
      };

      ws.onmessage = function (message) {
        var data = JSON.parse(message.data);
        if (data[0] === 'event') {
          switch (data[1].type) {
            case 'orientation' :
              triggerOrientation(data[1]);
              break;
            case 'pose' :
              triggerPose(data[1]);
              break;
            case 'locked' :
            case 'unlocked' :
              triggerArmbandLockUnlock(data[1]);
              break;
            case 'connected' :
              registerDevice(data[1]);
              break;
            case 'disconnected' :
              unregisterDevice(data[1]);
              break;
            case 'arm_recognized' :
            case 'arm_synced' :
              triggerArmRecognized(data[1]);
              break;
            case 'arm_lost' :
            case 'arm_unsynced' :
              triggerArmLost(data[1]);
              break;
            case 'emg' :
              triggerEmg(data[1]);
              break;
            case 'rssi' :
              triggerRssi(data[1]);
              break;
            default :
              console.log(data[1]);
              break;
          }
          safeDigest();
        }
      };

      /**
       * Create a new {@link MyoDevice} based on data and attach registered callbacks (see {@link Myo#on}
       * @param data - websocket data
       */
      var registerDevice = function (data) {
        var myoDevice = new MyoDevice(data.myo, data.version.join('.'), ws, eventsByDevice.get(data.myo));
        myoDevice.init();

        devices.set(data.myo, myoDevice);
        if (instanceOptions.broadcastOnConnected) {
          $rootScope.$broadcast('ngMyoConnected', data.myo);
        }

        myoDevice.onRegistered(data);
      };

      /**
       * Delete a {@link MyoDevice}. This is called on myo disconnected event
       * @param data - websocket data
       */
      var unregisterDevice = function (data) {
        devices.delete(data.myo);
        if (instanceOptions.broadcastOnDisconnected) {
          $rootScope.$broadcast('ngMyoDisconnected', data.myo);
        }
      };

      /**
       * Action when an orientation message is sent.
       * The action is not triggered if device is locked or if this event should be skipped (see {@link Myo#shouldSkipOrientation})
       * @param data - websocket data
       */
      var triggerOrientation = function (data) {
        var device = devices.get(data.myo);
        if (device && !device.isLocked() && !shouldSkipOrientation(device)) {
          var rpy, rpyDiff;
          if (instanceOptions.useRollPitchYaw) {
            rpy = MyoOrientation.calculateRPY(data.orientation, instanceOptions.rollPitchYawScale, device.direction());
            if (device.rpyOffset()) {
              rpyDiff = MyoOrientation.calculateRPYDiff(rpy, device.rpyOffset(), instanceOptions.rollPitchYawScale);
            }
          }
          device.onOrientation(data, rpy, rpyDiff);
        }
      };

      /**
       * Action when user perform arm recognition gesture
       * @param data - websocket data
       */
      var triggerArmRecognized = function (data) {
        var device = devices.get(data.myo);
        if (device) {
          device.onArmRecognized(data);
        }
      };

      /**
       * Action when arm is lost (myo device moved or removed)
       * @param data - websocket data
       */
      var triggerArmLost = function (data) {
        var device = devices.get(data.myo);
        if (device) {
          device.onArmLost(data);
        }
      };

      /**
       * Lock or unlock Myo device if device is registered and lock status is not already the one triggered
       * @param data - websocket data
       */
      var triggerArmbandLockUnlock = function (data) {
        var device = devices.get(data.myo);
        if (device) {
          if ((data.type === 'locked' && !device.isLocked()) ||
            data.type === 'unlocked' && device.isLocked()) {
            lockUnlockDevice(device);
          }
        }
      };

      /**
       * Action whe user perform a pose.
       * If pose is lock/unlock pose (defined in options, default is 'thumb_to_pinky'), only lock/unlock is performed.
       * Else registered callbacks are called (see {Myo#on}).
       * @param data - websocket data
       */
      var triggerPose = function (data) {
        console.log(data);
        var device = devices.get(data.myo);
        if (device) {
          $timeout.cancel(lockTimeouts.get(data.myo));

          if ('double_tap' === data.pose) {
            lockUnlockDevice(device);
          }

          if (instanceOptions.lockUnlockPose === data.pose) {
            createLockUnlockTimeout(device);
          }

          else if (!device.isLocked()) {
            executeDevicePose(device, data);
          }
        }
      };

      /**
       * EMG data plus timestamp
       * @param data - websocket data
       */
      var triggerEmg = function (data) {
        var device = devices.get(data.myo);
        if (device) {
          device.onEmgData(data);
        }
      };

      /**
       * RSSI (Bluetooth strength) data
       * @param data - websocket data
       */
      var triggerRssi = function (data) {
        var device = devices.get(data.myo);
        if (device) {
          device.onRssiData(data);
        }
      };

      /**
       * Actually lock or unlock the Myo device (called by createLockUnlockTimeout) and broadcast event depending on the options
       * @param device - the {@link MyoDevice}
       */
      var lockUnlockDevice = function (device) {
        device.lockOrUnlock();

        if (instanceOptions.broadcastOnLockUnlock) {
          $rootScope.$broadcast('ngMyo' + (device.isLocked() ? 'Lock' : 'Unlock'), device.id);
        }
      };

      /**
       * Lock or unlock device only if user perform the pose during the pose time defined in options (defaut 500ms).
       * @param device - the {@link MyoDevice}
       */
      var createLockUnlockTimeout = function (device) {
        createTimeout(device.id, function () {
          lockUnlockDevice(device);
        }, instanceOptions.lockUnlockPoseTime);
      };

      /**
       * Call device pose callbacks functions id the user perform the pose during the pose time defined in options (default 300ms)
       * @param device - the {@link MyoDevice}
       * @param data - the websocket message data
       */
      var executeDevicePose = function (device, data) {
        createTimeout(device.id, function () {
          device.onPose(data);
        }, instanceOptions.poseTime);
      };

      /**
       * Create timeout for a device. The fn will be called after time ms
       * @param deviceId - the device id
       * @param fn - the callback function
       * @param time - the time to wait in ms
       */
      var createTimeout = function (deviceId, fn, time) {
        var timeoutPromise = $timeout(fn, time);
        lockTimeouts.set(deviceId, timeoutPromise);
      };
    };
  }

  angular.module('ngMyo')
    .service('Myo', ['$rootScope', '$window', '$timeout', 'MyoOptions', 'MyoOrientation', Myo]);
})();
