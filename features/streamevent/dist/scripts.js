var StreamEvent = function () {
    var targeturl = null;
    var eventDefinition = {
        AdEvent: "ADEVENT",
        BinaryEvent: "BINARY_EVENT"
    };
    var self = this;
    var configuration = {};

    this.configure = function (config) {
        configuration = config;
    };

    this.getConfiguration = function () {
        return configuration;
    };

    this.initStreamEventsMethod = function() {
        logManager.log('Stream Events Listening Method init...');
        objVideo = serviceManager.getObjVideo();
        try {
            if (featuresManager.getFeature("streamEventDVBMethod")) {
                logManager.log("Adv Listening Method: streamEventDVBMethod");
                broadcastPlayStateCheck(registerStreamEventsListeners);
            } else if (featuresManager.getFeature("streamEventXMLMethod")) {
                logManager.log("Adv Listening Method: streamEventXMLMethod");
                broadcastPlayStateCheck(registerStreamEventsListeners);
            } else {
                logManager.log("Adv Listening Method: none (as per features file definition)");
            }
        } catch (e) {
            logManager.error("initStreamEventsMethod: " + e);
        }
    };

    function broadcastPlayStateCheck(callback) {
        if (objVideo) {
            if (objVideo.playState === 2) {
                logManager.log("presenting channel ready");
                // if video broadcast object is already in the presenting state add stream event listener
                callback();
            } else {
                logManager.log("presenting channel not ready, listen playstateChange");
                // if not, wait for the presenting state
                objVideo.onPlayStateChange = onPlayStateChangeCallback;
            }
        } else {
            logManager.warning("The application is broadcast dependent, try to attach to broadcast");
        }
    }

    /**
     * Listens for state changes and errors of the video broadcast object.
     *
     * If it goes to the presenting state add stream event listener.
     */
    function onPlayStateChangeCallback(state, error) {
        switch (state) {
            case 0: // unrealized
                logManager.log("state video broadcast: unrealized");
                break;
            case 1: // connecting
                logManager.log("state video broadcast: connecting");
                break;
            case 2: // presenting
                logManager.log("state video broadcast: presenting");
                self.initStreamEventsMethod();
                // remove listener of onPlayStateChangeCallback
                objVideo.onPlayStateChange = function () {
                };
                break;
            case 3: // stopped
                logManager.log("state video broadcast: stopped");
                break;
        }
    }

    function registerStreamEventsListeners() {
        try {
            targeturl = getUrlStreamEventObj();
            var e1, e2;
            if (targeturl != null) {
                logManager.log('streamEventObjectURL: ' + targeturl);
                e1 = objVideo.addStreamEventListener(targeturl, "ADEVENT", onAdEventReceived);
                logManager.log('ADEVENT Registered');
                e2 = objVideo.addStreamEventListener(targeturl, "BINARY_EVENT", onBinaryEventReceived);
                logManager.log('BINARY_EVENT Registered');
            } else {
                logManager.warning("registerEvents: Stream Events Listeners not registered, no Carousel definition for this channel");
            }
        } catch (e) {
            logManager.error("registerEvents: " + e);
        }
    }

    function unregisterStreamEventsListeners() {
        logManager.log('Stream event Unregistering...');
        try {
            if (onAdEventReceived) objVideo.removeStreamEventListener(targeturl, "ADEVENT", onAdEventReceived);
            logManager.log('ADEVENT Unregistered');
            if (onBinaryEventReceived) objVideo.removeStreamEventListener(targeturl, "BINARY_EVENT", onBinaryEventReceived);
            logManager.log('BINARY_EVENT Unregistered');
        } catch (e) {
            logManager.error('Error on Stream event Unregistered: ' + e.message);
        }
        logManager.log('Stream event Unregistered');
    }

    function getUrlStreamEventObj() {
        var channelString = null;
        if (featuresManager.getFeature("streamEventDVBMethod")) {
            var channelID = null;
            var type = null;
            var urlStreamEventObj = null;
            try {
                var ch = objVideo.currentChannel;
                if (ch) {
                    channelID = ch.onid.toString(16) + '.' + ch.tsid.toString(16) + '.' + ch.sid.toString(16);
                    logManager.log('current channel ID(hex) = ' + channelID + ', type=' + type + ', name=' + ch.name);
                } else {
                    logManager.warning('currentChannel not defined');
                }
            } catch (e) {
                logManager.error("getUrlStreamEventObj: " + e);
                throw e;
            }
            if (serviceManager.getCurrentChannel()) {
                channelString = serviceManager.getCurrentChannel().getChannelToString();
                if (self.getConfiguration().STREAM_EVENT_CONFIGURATION[channelString] == null) {
                    logManager.warning('getUrlStreamEventObj - No DVB STREAM EVENT CONFIGURATION for this channel (' + channelString + ')');
                } else {
                    urlStreamEventObj = "dvb://" + channelID + "." + self.getConfiguration().STREAM_EVENT_CONFIGURATION[channelString].DVB_OBJECT_CAROUSEL_COMPONENT_TAG.toString(16) + "/" + self.getConfiguration().STREAM_EVENT_CONFIGURATION[channelString].DVB_STREAM_EVENTS_OBJECT_NAME;
                }
            }
            return urlStreamEventObj;
        } else if (featuresManager.getFeature("streamEventXMLMethod")) {
            if (serviceManager.getCurrentChannel()) {
                channelString = serviceManager.getCurrentChannel().getChannelToString();
            }
            logManager.log(self.getConfiguration().STREAM_EVENT_CONFIGURATION[channelString].XML_STREAM_EVENTS_XML_DEFINITION);
            return self.getConfiguration().STREAM_EVENT_CONFIGURATION[channelString].XML_STREAM_EVENTS_XML_DEFINITION;
        }
    }
    this.test = function () {
        onBinaryEventReceived({
            name: eventDefinition.BinaryEvent,
            status: "trigger",
            text: "/DBeAAAAAAAAAP/wBQb+69/gsABIAhRDVUVJAAQGEX//AAApMuAAADAQEAIfQ1VFSQAEBv9/vwwQQURGUgEzoQE0Yo4EBgXDoAIAAAIPQ1VFSQAEBhB/vwAAMQ8QCVS2w///////////////////////////////////////////////////////////////////////////////////////////////////////////////////"
        });
    }

    function onBinaryEventReceived(obj, isRetry) {
        try {
            if (obj && obj.name === eventDefinition.BinaryEvent) {
                logManager.log('onBinaryEventReceived: ' + getPrintablePayload(obj));
                if (obj.status === "error") {
                    logManager.warning("Event onBinaryEventReceived on error status, re-registering Stream Events listeners.");
                    unregisterStreamEventsListeners();
                    self.initStreamEventsMethod();
                } else if (obj.status === "trigger") {
                    logManager.log("BINARY_EVENT received");
                    var parser = new SCTE35Parser();
                    if(isRetry) {
                        logManager.log("retrying...");
                    }
                    logManager.log("parsing with BASE64");
                    var decodedObj = parser.parseFromBase64(obj.text);
                    logManager.log(JSON.stringify(decodedObj));
                    var descriptors = decodedObj.descriptors;
                    var triggeredFn = {};
                    if(descriptors && descriptors.length > 0){
                        for(var i =0; i < descriptors.length; i++){
                            logManager.log(descriptors[i].segmentation_type_id);
                            if (self.getConfiguration().TRIGGERABLE_FN_ON_SCTE35_MAP && self.getConfiguration().TRIGGERABLE_FN_ON_SCTE35_MAP[descriptors[i].segmentation_type_id] && self.getConfiguration().TRIGGERABLE_FN_ON_SCTE35_MAP[descriptors[i].segmentation_type_id].FN){
                                logManager.log("triggerable function by " + descriptors[i].segmentation_type_id + " found");
                                var params = {};
                                var attributesFilter = self.getConfiguration().TRIGGERABLE_FN_ON_SCTE35_MAP[descriptors[i].segmentation_type_id].ATTRIBUTES;
                                if(attributesFilter && attributesFilter.length > 0){
                                    for(var j=0; j < attributesFilter.length; j++){
                                        params[attributesFilter[j]] = descriptors[i][attributesFilter[j]];
                                    }
                                }
                                triggeredFn[descriptors[i].segmentation_type_id] = self.getConfiguration().TRIGGERABLE_FN_ON_SCTE35_MAP[descriptors[i].segmentation_type_id].FN(params, decodedObj);
                            }
                        }
                    } else {
                        if(!isRetry){//prevent loop
                            onBinaryEventReceived(obj,true);
                        }
                    }
                }
            } else {
                if (obj) {
                    logManager.warning('onBinaryEventReceived - wrong event Name: ' + obj.name);
                } else {
                    logManager.warning('onBinaryEventReceived - payload not defined');
                }
            }
        } catch (e) {
            logManager.error('onBinaryEventReceived - error: ' + e.message);
        }
    }

    function onAdEventReceived(obj) {
        try {
            if (obj && obj.name === eventDefinition.AdEvent) {
                logManager.log('onAdEventReceived: ' + getPrintablePayload(obj));
                if (obj.status === "error") {
                    logManager.warning("Event onAdEventReceived on error status, re-registering Stream Events listeners.");
                    unregisterStreamEventsListeners();
                    self.initStreamEventsMethod();
                } else if (obj.status === "trigger") {
                    if (obj.text) {
                        var payloadEvent = JSON.parse(obj.text);
                        if (!payloadEvent.hasOwnProperty("event_type")) {
                            //single Stream Event management
                            if(self.getConfiguration().TRIGGERABLE_FN_ON_EVENT) {
                                self.getConfiguration().TRIGGERABLE_FN_ON_EVENT(obj);
                            }
                        } else {
                            logManager.error('onAdEventReceived - Stream Event ignored.');
                        }
                    } else {
                        logManager.error('onAdEventReceived - empty payload!');
                    }
                }
            } else {
                if (obj) {
                    logManager.warning('onAdEventReceived - wrong event Name: ' + obj.name);
                } else {
                    logManager.warning('onAdEventReceived - payload not defined');
                }
            }
        } catch (e) {
            logManager.error('onAdEventReceived - error: ' + e.message);
        }
    }

    function getPrintablePayload(obj) {
        var text = "";
        try {
            var payload = JSON.stringify(obj, null, 4);
            if (payload === "{}") {
                text = "Status:" + obj.status + " - Text: " + obj.text;
            } else {
                text = payload;
            }
        } catch (e) {
        }
        return text;
    }

};
/**
 * Reference:
 1. SCTE-35 spec: http://www.scte.org/SCTEDocs/Standards/SCTE%2035%202016.pdf
 **/
function SCTE35Parser() {

    this.init = function() {
        this.scte35_bitarray = new Array();
        this.spliceInfo = {};
    }

    function base64toHEX(base64) {
        var raw = atob(base64);
        var HEX = '';
        for (i = 0; i < raw.length; i++) {
            var _hex = raw.charCodeAt(i).toString(16)
            HEX += (_hex.length == 2 ? _hex : '0' + _hex);
        }
        return HEX;
    }

    this.parseFromBase64 = function(data) {
        this.init();
        var raw = window.atob(data);
        var rawLength = raw.length;
        var array = new Uint8Array(new ArrayBuffer(rawLength));

        for(var i = 0; i < rawLength; i++) {
            array[i] = raw.charCodeAt(i);
            this.writeToBitArray(array[i]);
        }
        this.parse();
        return this.spliceInfo;
    }

    this.parseFromHex = function(data) {
        this.init();
        if (!data || data.length < 0) {
            return 'no data';
        }
        for (var i = 0; i < data.length; i+=2) {
            var d = parseInt('0x' + data[i] + data[i+1]);
            this.writeToBitArray(parseInt(data[i] + data[i+1], 16));
        }
        this.parse();
        return this.spliceInfo;
    }

    this.parse = function() {
        var table_id = this.read(8);
        if (table_id == 0xfc) { // table_id – This is an 8-bit field. Its value shall be 0xFC for SpliceInfo.
            var spliceInfo = this.spliceInfo;
            spliceInfo.segmentation_type_id_list = [];//custom field - contains list of each descriptor segmentation type id
            spliceInfo.table_id = table_id;
            spliceInfo.section_syntax_indicator = this.read(1);
            spliceInfo.private_indicator = this.read(1);
            //reserved 2 bits
            this.read(2);
            spliceInfo.section_length = this.read(12);
            spliceInfo.protocol_version = this.read(8);
            spliceInfo.encrypted_packet = this.read(1);
            spliceInfo.encryption_algorithm = this.read(6);
            spliceInfo.pts_adjustment = this.read(33);
            spliceInfo.cw_index = this.read(8);
            spliceInfo.tier = this.read(12);
            spliceInfo.splice_command_length = this.read(12);

            spliceInfo.splice_command_type = this.read(8);

            if (spliceInfo.splice_command_type == 0x00) {
                this.parse_splice_null();
            } else if (spliceInfo.splice_command_type == 0x04) {
                this.parse_splice_schedule();
            } else if (spliceInfo.splice_command_type == 0x05) {
                spliceInfo.splice_command_type_text = 'splice_insert';
                this.parse_splice_insert();
            } else if (spliceInfo.splice_command_type == 0x06) {
                spliceInfo.splice_command_type_text = 'time_signal';
                this.parse_time_signal();
            } else if (spliceInfo.splice_command_type == 0x07) {
                this.bandwidth_reservation();
            } else if (spliceInfo.splice_command_type == 0x06) {
                this.parse_private_command();
            }

            spliceInfo.descriptor_loop_length = this.read(16);
            spliceInfo.descriptors = [];

            var remainingBytes = this.scte35_bitarray.length;
            for(var i = 0; i < spliceInfo.descriptor_loop_length; i++) {
                if(remainingBytes - this.scte35_bitarray.length >= spliceInfo.descriptor_loop_length*8){
                    break;
                }
                var descriptor = {};
                descriptor.splice_descriptor_tag = this.read(8);
                descriptor.descriptor_length = this.read(8);
                descriptor.identifier = this.read(32);
                if(descriptor.identifier == 0x43554549) {
                    switch (descriptor.splice_descriptor_tag) {
                        case 0://Avail Descriptor
                            break;
                        case 1://DTMF Descriptor
                            break;
                        case 2://Segmentation Descriptor
                            descriptor.segmentation_event_id = this.read(32);
                            descriptor.segmentation_event_cancel_indicator = this.read(1);
                            descriptor.reserved = this.read(7);
                            if (descriptor.segmentation_event_cancel_indicator == "0") {
                                descriptor.program_segmentation_flag = this.read(1);
                                descriptor.segmentation_duration_flag = this.read(1);
                                descriptor.delivery_not_restricted_flag = this.read(1);
                                if (descriptor.delivery_not_restricted_flag == "0") {
                                    descriptor.web_delivery_allowed_flag = this.read(1);
                                    descriptor.no_regional_blackout_flag = this.read(1);
                                    descriptor.archive_allowed_flag = this.read(1);
                                    descriptor.device_restrictions = this.read(2);
                                } else {
                                    descriptor.reserved = this.read(5);
                                }
                                if (descriptor.program_segmentation_flag == "0") {
                                    descriptor.component_count = this.read(8);
                                    descriptor.components = [];
                                    for (var k = 0; k < descriptor.component_count; k++) {
                                        var component = {};
                                        component.component_tag = this.read(8);
                                        component.reserved = this.read(7);
                                        component.pts_offset = this.read(33);
                                        descriptor.components.push(component);
                                    }
                                }
                            }
                            if (descriptor.segmentation_duration_flag == "1") {
                                descriptor.segmentation_duration = this.read(40);
                            }
                            descriptor.segmentation_upid_type = this.read(8);
                            descriptor.segmentation_upid_length = this.read(8);

                            //descriptor.segmentation_upid = this.read(8);
                            this.parse_segmentation_upid(descriptor);

                            descriptor.segmentation_type_id = this.read(8);
                            spliceInfo.segmentation_type_id_list.push(descriptor.segmentation_type_id);//custom list to resume how many and which descriptor has been found
                            switch (descriptor.segmentation_type_id) {//logging segmentation type
                                case 0x00:
                                   logManager.log("Type = Not Indicated\n");
                                    break;
                                case 0x01:
                                   logManager.log("Type = Content Identification\n");
                                    break;
                                case 0x10:
                                   logManager.log("Type = Program Start\n");
                                    break;
                                case 0x11:
                                   logManager.log("Type = Program End\n");
                                    break;
                                case 0x12:
                                   logManager.log("Type = Program Early Termination\n");
                                    break;
                                case 0x13:
                                   logManager.log("Type = Program Breakaway\n");
                                    break;
                                case 0x14:
                                   logManager.log("Type = Program Resumption\n");
                                    break;
                                case 0x15:
                                   logManager.log("Type = Program Runover Planned\n");
                                    break;
                                case 0x16:
                                   logManager.log("Type = Program Runover Unplanned\n");
                                    break;
                                case 0x17:
                                   logManager.log("Type = Program Overlap Start\n");
                                    break;
                                case 0x20:
                                   logManager.log("Type = Chapter Start\n");
                                    break;
                                case 0x21:
                                   logManager.log("Type = Chapter End\n");
                                    break;
                                case 0x30:
                                   logManager.log("Type = Provider Advertisement Start\n");
                                    break;
                                case 0x31:
                                   logManager.log("Type = Provider Advertisement End\n");
                                    break;
                                case 0x32:
                                   logManager.log("Type = Distributor Advertisement Start\n");
                                    break;
                                case 0x33:
                                   logManager.log("Type = Distributor Advertisement End\n");
                                    break;
                                case 0x34:
                                   logManager.log("Type = Placement Opportunity Start\n");
                                    break;
                                case 0x35:
                                   logManager.log("Type = Placement Opportunity End\n");
                                    break;
                                case 0x40:
                                   logManager.log("Type = Unscheduled Event Start\n");
                                    break;
                                case 0x41:
                                   logManager.log("Type = Unscheduled Event End\n");
                                    break;
                                case 0x50:
                                   logManager.log("Type = Network Start\n");
                                    break;
                                case 0x51:
                                   logManager.log("Type = Network End\n");
                                    break;
                                default:
                                   logManager.log("Type = Unknown = " + descriptor.segmentation_type_id + "\n");
                                    break;
                            }
                            descriptor.segment_num = this.read(8);
                            descriptor.segments_expected = this.read(8);
                            break;
                        case 3://Time Descriptor
                            break;
                        case 4://Audio Descriptor
                            break;
                        //0x05 – 0xFF  Reserved for future SCTE splice_descriptors
                    }

                    spliceInfo.descriptors.push(descriptor);
                } else {
                    this.read((descriptor.descriptor_length*8) - 32);//removing 32 bits of identifier
                }

            }
        }
    }

    this.parse_splice_null = function() {
        throw 'command_type splice_null not supported yet';
    }

    this.parse_splice_schedule = function() {
        throw 'command_type splice_schedule not supported yet';
    }

    this.parse_splice_insert = function() {
        var splice_event = {};
        this.spliceInfo.splice_event = splice_event;
        splice_event.splice_event_id = this.read(32);
        splice_event.splice_event_cancel_indicator = this.read(1);
        //reserved 7 bits
        this.read(7);
        if (splice_event.splice_event_cancel_indicator == 0) {
            splice_event.out_of_network_indicator = this.read(1);
            splice_event.program_splice_flag = this.read(1);
            splice_event.duration_flag = this.read(1);
            splice_event.splice_immediate_flag = this.read(1);
            //reserved 4 bits
            this.read(4);
            if((splice_event.program_splice_flag == 1) && (splice_event.splice_immediate_flag == 0)) {
                this.parse_splice_time(this.spliceInfo.splice_event);
            }

            if(splice_event.duration_flag == 1) {
                this.parse_break_duration();
            }
            splice_event.unique_program_id = this.read(16);
            splice_event.avail_num = this.read(8);
            splice_event.avails_expected = this.read(8);
        }
    }

    this.parse_time_signal = function() {
        //throw 'command_type time_signal not supported yet';
        var splice_event = {};
        this.spliceInfo.splice_event = splice_event;
        this.parse_splice_time(splice_event);

    }

    this.parse_bandwidth_reservation = function() {
        throw 'command_type bandwidth_reservation not supported yet';
    }

    this.parse_private_command = function() {
        throw 'command_type private_command not supported yet';
    }

    this.parse_splice_time = function (spliceEvent) {
        spliceEvent.time_specified_flag = this.read(1);
        if(spliceEvent.time_specified_flag == 1) {
            //reserved 6 bits
            this.read(6);
            spliceEvent.pts_time = this.read(33);
        } else {
            //reserved 7 bits
            this.read(7);
        }
    }

    this.parse_break_duration = function() {
        var break_duration = {};
        this.spliceInfo.splice_event.break_duration = break_duration;
        break_duration.auto_return = this.read(1);
        break_duration.reserved = this.read(6);
        break_duration.duration = this.read(33);
    }

    this.parse_segmentation_upid = function (descriptor) {
        switch (descriptor.segmentation_upid_type) {
            case 0x00:
                break;
            case 0x08:
                break;
            case 0xC://value when segmentation_type_id is 0x02
                descriptor.identifier_format = this.read(32);
                //segmentation_upid_length is the length of both data in bytes, so need to be converted to bits doing * 8
                descriptor.segmentation_upid = this.read(descriptor.segmentation_upid_length*8 - 32);//performance can be improved doing <<3 (bit shifting) instead of *8
                break;
            case 0x0F://15
                var upidLengthInBits = descriptor.segmentation_upid_length*8;

                var stringUpid= "";
                for(var i=0; i < descriptor.segmentation_upid_length; i++){
                    var singleByteInUpid = this.read(8);
                    stringUpid += String.fromCharCode(singleByteInUpid);
                }
                descriptor.segmentation_upid = stringUpid;
                break;
            default: //!= 0x00
                break;
        }
    }

    this.writeToBitArray = function(val) {
        var r = 128;
        for (var i=0; i<8; i++){
            var bVal = false;
            if(r & val) {
                bVal = true;
            }
            this.scte35_bitarray[this.scte35_bitarray.length] = bVal;
            r = r >> 1;
        }
    }

    this.read = function(size) {
        var a = this.scte35_bitarray.splice(0, size);
        var hSigNum = 0;
        if (size > 32) {
            for(var i = 0; i < size - 32; i++){
                hSigNum = hSigNum << 1;
                var aVal = a.shift();
                if (aVal) {
                    hSigNum += 1;
                }
            }
            hSigNum = hSigNum * Math.pow(2, 32);
            size = 32;
        }
        var num = 0;
        for(var i = 0; i < size; i++){
            num = num << 1;
            var aVal = a.shift();
            if (aVal) {
                num += 1;
            }
        }
        if (size >= 32) {
            num = num>>>0;
        }
        return hSigNum + num;
    }

    this.test = function(testString) {
        //var testString = 'fc300800000000000000001000067f234567890010020043554549400000007f9c00000000';
        if(!testString){
            testString = 'fc302000000000000000fff00f05000000007fcfffa7f7abd400680001000088f3ebaf';
        }
       logManager.log('testString = ' + testString);
        var spliceInfo = this.parseFromHex(testString);
       logManager.log(this.scte35_array);
       logManager.log(JSON.stringify(spliceInfo));

    }

}