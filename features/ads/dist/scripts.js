var Adv = function () {
    var self = this;
    var advHashmap = new AdvHashmap();
    var request = new AdvRequests();
    var breakTimer;
    var dictionary = {};

    this.ptsHandlerComponent = new PtsHandlerComponent();

    this.callAdServerRoundTripTime = 0;

    var configuration = {};

    function configure(config) {
        configuration = config;
    }

    function getConfiguration() {
        return configuration;
    }

    function startSCTEProcess(scte_attributes, scte_json) {
        var startInterval = null;
        var checkIfReadyToStart = function (iteration) {
            if(iteration > 10){//avoid infinity loop
                window.clearInterval(startInterval);
            }
            var loadedAdId = advHashmap.getLoadedAdv();
            if (!loadedAdId) {
                logManager.warning('startSCTEProcess - no dictionary loaded with ' + scte_attributes.segmentation_upid);
            } else {//already loaded
                var currentAdv = advHashmap.getValue(loadedAdId);
                if (currentAdv.status !== advHashmap.lstStatus.LOADED && currentAdv.status !== advHashmap.lstStatus.STARTED) {
                    logManager.warning('startSCTEProcess - incorrect status : ' + currentAdv.status);
                    return;
                }
                advHashmap.setStatus(loadedAdId, advHashmap.lstStatus.STARTED);
                /*if (!dictionary.spots.hasOwnProperty(payloadEvent.STARTdata.sequence)) { //Check if requested sequence is available in the Dictionary
                    logManager.warning('startEventProcess - sequence not found: ' + payloadEvent.STARTdata.sequence);
                    return;
                }*/
                scte_attributes.segmentation_upid = loadedAdId;//since there is no segmentation_upid in 0x30, inject it from previous 0x02 ad call
                startSCTEEventProcess(scte_attributes, scte_json);
                window.clearInterval(startInterval);
            }
        };
        var waitConcurrentLoad = scte_json.segmentation_type_id_list && scte_json.segmentation_type_id_list.indexOf(0x02)> -1;
        if(waitConcurrentLoad) {
            var iteration = 0;
            startInterval = setInterval(function () {
                checkIfReadyToStart(iteration++);
            }, 1000);
        }else{
            checkIfReadyToStart();
        }

    }

    function onFiredAdv(obj) {//obj is the stream event payload which trigger this fn
        if (configuration.AD_SUBSTITUTION_METHOD === "spot") {
            startEventProcess(obj.text);
        } else if (configuration.AD_SUBSTITUTION_METHOD === "break") {
            callAdServerProcess(obj.text, null);
        } else {
            logManager.warning("onAdEventReceived - No SpotMode or BreakMode set in the configuration.");
        }
    }

    function startEventProcess(objString) {
        //
        //Example event payload:
        // {
        //  "LOADdata":
        //    {
        //      "dai_version":"1.0",
        //      "channel":"33a1",
        //      "break_code":"1430",
        //      "triplet":"65535.6.1537",
        //      "break_duration":"291320"
        //    },
        //  "STARTdata":
        //    {
        //      "break_code":"1430",
        //      "sequence":1,
        //      "duration":30000,
        //      "triplet":"65535.6.1537",
        //      "pts":45023032
        //    }
        // }
        try {
            var payloadEvent = JSON.parse(objString);
            if (payloadEvent.STARTdata.triplet !== serviceManager.getCurrentChannel().getChannelToString()) { //Triplet match check
                logManager.warning('startEventProcess - event triplet (' + payloadEvent.STARTdata.triplet + ') not corresponding to current channel\'s triplet (' + serviceManager.getCurrentChannel().getChannelToString() + ')');
                return;
            }
            if (!advHashmap.getValue(payloadEvent.STARTdata.break_code)) {
                //If this event's break_code is not in the dictionary yet, callAdServer is triggered.
                if (configuration.CALL_ADSERVER_FALLBACK_ON_STARTEVENT && configuration.AD_SUBSTITUTION_METHOD === 'spot') {
                    logManager.log('startEventProcess - break_code not found in dictionary: triggering callAdServer.');
                    callAdServerProcess(objString, function () {
                        //Going back to the START tracking after the callAdServer fallback.
                        startEventProcessPostValidation(objString);
                    });
                } else {
                    logManager.warning('startEventProcess - break code not found in dictionary.');
                }
            } else {
                startEventProcessPostValidation(objString);
            }
        } catch (e) {
            logManager.error('startEventProcess - error: ' + e.message);
        }
    }

    function callVastAdServerProcess(adStaticConf, scte_attributes, scte_json) {
        if (advHashmap.isAdvIDExists(scte_attributes.segmentation_upid)) { //Check if there's already an entry in the advHashmap
            logManager.warning('callAdServerProcess - break code already loaded');
            return;
        }
        advHashmap.initialize(scte_attributes.segmentation_upid);
        // advID never received yet => we continue to manage the id
        advHashmap.setStatus(scte_attributes.segmentation_upid, advHashmap.lstStatus.LOADING);
        request.doFreewheelAdCall(adStaticConf, scte_attributes, scte_json,
            function (xmldata) { //This call is asynchronous, later the app checks if it's data is successfully retrieved.
                if (xmldata && xmldata.getElementsByTagNameNS("http://www.iab.net/vmap-1.0", "VMAP").length === 0) {
                    logManager.log("onFiredSCTEAdv - VAST file is an empty object.");
                    return;
                }
                createDictionaryVAST(scte_attributes.segmentation_upid, xmldata);
                //Save dictionary on queue
                advHashmap.setValue(scte_attributes.segmentation_upid, dictionary, advHashmap.type.STREAMEVENT);
                advHashmap.setStatus(scte_attributes.segmentation_upid, advHashmap.lstStatus.LOADED);

            }, function (error) {
                clearAdv(scte_attributes.segmentation_upid);
                logManager.error("doFreewheelAdCall() KO Response");
            });
    }

    function callAdServerProcess(objString, resumeStartFallbackCallback) {
        try {
            if (featuresManager.getFeature("linearAdTracking") == null || featuresManager.getFeature("linearAdTracking") !== true) {
                logManager.warning('callAdServerProcess - linearAdTracking feature is not true');
                return;
            }
            if (consent && (consent.getModel() == null || consent.getModelConsents().TRACKING.consentStatus !== true)) { //Check TRACKING user consent status (Mandatory)
                logManager.warning('callAdServerProcess - user consent not given to TRACKING');
                return;
            }
            var payloadEvent = JSON.parse(objString);
            if (Object.keys(dictionary).length !== 0 && configuration.AD_SUBSTITUTION_METHOD === 'break') {
                logManager.warning("callAdServerProcess - Discarding Event: Break tracking already in progress.");
                return;
            }
            if (payloadEvent.LOADdata.triplet !== serviceManager.getCurrentChannel().getChannelToString()) { //Triplet match check
                logManager.warning('callAdServerProcess - event triplet (' + payloadEvent.LOADdata.triplet + ') not corresponding to current channel\'s triplet (' + serviceManager.getCurrentChannel().getChannelToString() + ')');
                return;
            }
            if (advHashmap.isAdvIDExists(payloadEvent.LOADdata.break_code)) { //Check if there's already an entry with the same break code in the advHashmap
                logManager.warning('callAdServerProcess - break code already loaded');
                return;
            }
            advHashmap.initialize(payloadEvent.LOADdata.break_code);
            // advID never received yet => we continue to manage the id
            advHashmap.setStatus(payloadEvent.LOADdata.break_code, advHashmap.lstStatus.LOADING);
            if (consent && consent.getModel() == null) {
                logManager.warning("callAdServerProcess - getWizadsData() the tvId is not retrived yet");
                return;
            }
            if (payloadEvent.LOADdata.channel) { // workaround to force channel uppercase - quicker than fix it on BEN
                payloadEvent.LOADdata.channel = payloadEvent.LOADdata.channel.toUpperCase();
            }
            var tvID = consent ? consent.getModel().tvId : "";
            var transactionID = tvID + (new Date()).getTime(); //random number
            var daiVersion = payloadEvent.LOADdata.dai_version;
            var channel = payloadEvent.LOADdata.channel;
            var breakCode = payloadEvent.LOADdata.break_code;
            var breakDay = payloadEvent.LOADdata.bday || "";
            var breakduration = payloadEvent.LOADdata.break_duration;
            var platform = core.getPlatform().brand.toLowerCase().trim();
            var response_type = configuration.AD_SUBSTITUTION_METHOD;
            var url = configuration.ADSERVER_URL;
            url += "?dai_version=" + daiVersion + "&transaction_id=" + transactionID + "&response_type=" + response_type + "&channel=" + channel + "&break_code=" + breakCode +
                "&break_day=" + breakDay + "&break_duration=" + breakduration + "&advertising_id=" + tvID + "&platform=" + platform + "&context=live&current_spot=0";
            var roundTripStart = Date.now();
            request.getWizadsData(url,
                function (data) { //This call is asynchronous, later the app checks if it's data is successfully retrieved.
                    self.callAdServerRoundTripTime = Date.now() - roundTripStart;
                    if (Object.keys(data).length === 0) {
                        logManager.log("callAdServerProcess - VAST file is an empty object.");
                        return;
                    }
                    createDictionary(payloadEvent.LOADdata.break_code, data);
                    //Save dictionary on queue
                    advHashmap.setValue(payloadEvent.LOADdata.break_code, dictionary, advHashmap.type.STREAMEVENT);
                    advHashmap.setStatus(payloadEvent.LOADdata.break_code, advHashmap.lstStatus.LOADED);

                    if (resumeStartFallbackCallback != null) {
                        resumeStartFallbackCallback();
                    }

                    if (configuration.AD_SUBSTITUTION_METHOD === 'break') {
                        breakTracking(payloadEvent);
                    }
                }, function (error) {
                    clearAdv(payloadEvent.LOADdata.break_code);
                    logManager.error("getWizadsData() KO Response");
                });
        } catch (e) {
            logManager.error('callAdServerProcess - error: ' + e.message);
        }
    }

    function startSCTEEventProcess(scte_attributes, scte_json) {
        self.ptsHandlerComponent.ptsStartEventTimeCheck(scte_json.splice_event.pts_time, null, function () {
            if (featuresManager.getFeature("linearAdTracking") && featuresManager.getFeature("linearAdTracking") === true) {
                scheduleSpotTracking(scte_attributes.segment_num, scte_attributes.segmentation_upid);
            }
        }); //the LOAD event is triggered as soon as it is received, and then Ad Starts are triggered using their PTS
    }

    function startEventProcessPostValidation(objString) {
        var payloadEvent = JSON.parse(objString);
        var currentAdv = advHashmap.getValue(payloadEvent.STARTdata.break_code);
        if (currentAdv.status !== advHashmap.lstStatus.LOADED && currentAdv.status !== advHashmap.lstStatus.STARTED) {
            logManager.warning('startEventProcess - incorrect status : ' + currentAdv.status);
            return;
        }
        advHashmap.setStatus(payloadEvent.STARTdata.break_code, advHashmap.lstStatus.STARTED);
        if (!dictionary.spots.hasOwnProperty(payloadEvent.STARTdata.sequence)) { //Check if requested sequence is available in the Dictionary
            logManager.warning('startEventProcess - sequence not found: ' + payloadEvent.STARTdata.sequence);
            return;
        }
        logManager.log("startEventProcessPostValidation - Event payload: " + objString);
        if (payloadEvent.STARTdata.duration !== dictionary.spots[payloadEvent.STARTdata.sequence].duration) { //Spot Duration check
            logManager.warning('startEventProcess - spot duration in Stream Event payload (' + payloadEvent.STARTdata.duration + ') not matching the VAST duration for this spot (' + dictionary.spots[payloadEvent.STARTdata.sequence].duration + ')');
            return;
        }
        switch (configuration.AD_SUBSTITUTION_METHOD) { //Replacement mode switch
            case "spot":
                if (featuresManager.getFeature("PTSMethod")) {
                    self.ptsHandlerComponent.ptsStartEventTimeCheck(payloadEvent.STARTdata.pts, payloadEvent, startEventCoreProcess); //In spot mode the LOAD event is triggered as soon as it is received, and then Ad Starts are triggered using their PTS
                } else {
                    logManager.warning('startEventProcess - no PTS or Delay method for this client in the feature file.');
                }
                break;
            case "break":
                startEventCoreProcess(payloadEvent);
                break;
            default:
                logManager.warning('startEventProcess - no "break" or "spot" mode enabled.');
                break;
        }
    }

    function createDictionaryVAST(segmentation_upid, xml) {
        try {
            /*jshint ignore:start*/
            dictionary = {};
            logManager.log("createDictionaryVAST() - Creating dictionary");
            var adBreak = xml.getElementsByTagNameNS("http://www.iab.net/vmap-1.0", "VMAP")[0].getElementsByTagNameNS("http://www.iab.net/vmap-1.0", "AdBreak");
            if(adBreak.length == 0){
                logManager.log("createDictionaryVAST() - no Ad Break found in VAST file.");
            }else{
                try {
                    var vast = adBreak[0].getElementsByTagNameNS("http://www.iab.net/vmap-1.0", "AdSource")[0].getElementsByTagNameNS("http://www.iab.net/vmap-1.0", "VASTAdData")[0].getElementsByTagName("VAST")[0];
                    var arrayAds = vast.getElementsByTagName("Ad");
                }catch (e) {
                    logManager.log("createDictionaryVAST() - error on VAST parsing. " + e);
                }
            }
            if (arrayAds.length > 0) {
                dictionary.id = segmentation_upid;
                logManager.log("createDictionaryVAST() - dictionary.id: " + dictionary.id);
                dictionary.spots = [];
                for (var i = 0; i < arrayAds.length; i++) {
                    dictionary.spots[parseInt(arrayAds[i].getAttribute("sequence"))] = createTrackingItemsForDictionaryVAST(arrayAds[i]);
                    logManager.log('createDictionaryVAST() - dictionary.spots[' + (parseInt(arrayAds[i].getAttribute("sequence"))) + '] tracking items loaded');
                }
            } else {
                logManager.log("createDictionaryVAST() - no Ads found in VAST file.");
            }
            /*jshint ignore:end*/
        } catch (e) {
            logManager.error("createDictionaryVAST: " + e);
        }
    }

    function createDictionary(break_code, data) {
        try {
            /*jshint ignore:start*/
            dictionary = {};
            logManager.log("createDictionary() - Creating dictionary");
            var arrayAds = data.Ads;
            if (arrayAds.length > 0) {
                dictionary.id = break_code;
                logManager.log("createDictionary() - dictionary.id: " + dictionary.id);
                dictionary.spots = [];
                for (var i = 0; i < arrayAds.length; i++) {
                    dictionary.spots[parseInt(arrayAds[i].Sequence)] = createDictionaryItems(arrayAds[i]);
                    logManager.log('createDictionary() - dictionary.spots[' + (parseInt(arrayAds[i].Sequence)) + '] tracking items loaded');
                }
            } else {
                logManager.log("createDictionary() - no Ads found in VAST file.");
            }
            /*jshint ignore:end*/
        } catch (e) {
            logManager.error("createDictionary: " + e);
        }
    }

    function createTrackingItemsForDictionaryVAST(currentAD) {
        try {
            var item = {};
            var durationHms = currentAD.getElementsByTagName("InLine")[0].getElementsByTagName("Creatives")[0].getElementsByTagName("Creative")[0].getElementsByTagName("Linear")[0].getElementsByTagName("Duration")[0];
            var durationArray = durationHms.textContent.split(':');
            item["duration"] = (+durationArray[0]) * 60 * 60 + (+durationArray[1]) * 60 + (+durationArray[2]) * 1000;
            item["tracking"] = {};
            var trackingNodes = currentAD.getElementsByTagName("InLine")[0].getElementsByTagName("Creatives")[0].getElementsByTagName("Creative")[0].getElementsByTagName("Linear")[0].getElementsByTagName("TrackingEvents")[0].getElementsByTagName("Tracking");
            item.tracking["impression"] = currentAD.getElementsByTagName("InLine")[0].getElementsByTagName("Impression")[0].textContent.trim();
            for (var i = 0; i < trackingNodes.length; i++) {
                switch (trackingNodes[i].getAttribute("event")) {
                    case "firstQuartile":
                        item.tracking["firstQuartile"] = trackingNodes[i].textContent.trim();
                        break;
                    case "midpoint":
                        item.tracking["midpoint"] = trackingNodes[i].textContent.trim();
                        break;
                    case "thirdQuartile":
                        item.tracking["thirdQuartile"] = trackingNodes[i].textContent.trim();
                        break;
                    case "complete":
                        item.tracking["complete"] = trackingNodes[i].textContent.trim();
                        break;
                }
            }
            var mediaFileUrl = currentAD.getElementsByTagName("InLine")[0].getElementsByTagName("Creatives")[0].getElementsByTagName("Creative")[0].getElementsByTagName("Linear")[0].getElementsByTagName("MediaFiles")[0].getElementsByTagName("MediaFile")[0].textContent.trim();
            /*jshint ignore:start*/
            item["media_file_url"] = mediaFileUrl;
            //Type is "ADDRESSED" by default.
            item["media_file_type"] = "addressed";
            /*jshint ignore:end*/
            if (mediaFileUrl.indexOf(".mp4") !== -1 || mediaFileUrl.indexOf(".mpd") !== -1) {
                item["media_file_type"] = "broadcasted";
            }
            return item;
        } catch (e) {
            logManager.error("createTrackingItemsForDictionary: " + e);
        }
    }

    function createDictionaryItems(arrayAd) {
        var item;
        item = createTrackingItemsForDictionary(arrayAd);
        /*jshint ignore:start*/
        item['companionAd'] = createCompanionAdForDictionary(arrayAd);
        /*jshint ignore:end*/
        return item;
    }

    function createTrackingItemsForDictionary(currentAD) {
        try {
            var item = {};
            /*jshint ignore:start*/
            var durationHms = currentAD.InLine.Creatives[0].Linear.Duration;
            //var durationArray = durationHms.split(':');
            //item["duration"] = (+durationArray[0]) * 60 * 60 + (+durationArray[1]) * 60 + (+durationArray[2]) * 1000;
            item["duration"] = (+durationHms) * 1000;
            item["tracking"] = {};
            var trackingNodes = currentAD.InLine.Creatives[0].Linear.TrackingEvents;
            item.tracking["impression"] = currentAD.InLine.Impressions[0].Data.trim();
            /*jshint ignore:end*/
            for (var i = 0; i < trackingNodes.length; i++) {
                /*jshint ignore:start*/
                switch (trackingNodes[i].Event) {
                    case "firstQuartile":
                        item.tracking["firstQuartile"] = trackingNodes[i].Data.trim();
                        break;
                    case "midpoint":
                        item.tracking["midpoint"] = trackingNodes[i].Data.trim();
                        break;
                    case "thirdQuartile":
                        item.tracking["thirdQuartile"] = trackingNodes[i].Data.trim();
                        break;
                    case "complete":
                        item.tracking["complete"] = trackingNodes[i].Data.trim();
                        break;
                }
                /*jshint ignore:end*/
            }
            var mediaFileUrl = currentAD.InLine.Creatives[0].Linear.MediaFiles[0].Data.trim();
            /*jshint ignore:start*/
            item["media_file_url"] = mediaFileUrl;
            /*jshint ignore:end*/
            //Type is "ADDRESSED" by default.
            /*jshint ignore:start*/
            item["media_file_type"] = "addressed";
            /*jshint ignore:end*/
            if (mediaFileUrl.indexOf("broadcasted") !== -1) {
                /*jshint ignore:start*/
                item["media_file_type"] = "broadcasted";
                /*jshint ignore:end*/
            }
            return item;
        } catch (e) {
            logManager.error("createTrackingItemsForDictionary: " + e);
        }
    }

    function createCompanionAdForDictionary(currentAD) {
        try {
            var item = {};
            /*jshint ignore:start*/
            if (currentAD.InLine.Creatives[0].CompanionAds != null) {
                item = currentAD.InLine.Creatives[0].CompanionAds;
            }
            /*jshint ignore:end*/
            return item;
        } catch (e) {
            logManager.error("createCompanionAdForDictionary: " + e);
        }
    }

    function startEventCoreProcess(payloadEvent) {
        var currentAdv = advHashmap.getValue(payloadEvent.STARTdata.break_code);
        if (!currentAdv) {
            logManager.warning('startEventCoreProcess - break code not found');
            return;
        }
        //not needed anymore - if Tracking consent status is not true, ad server call is not performed and this check will not be done
        if (consent && (consent.getModel() == null || consent.getModelConsents().TRACKING.consentStatus !== true)) { //Check TRACKING user consent status (Mandatory for all next steps)
            logManager.warning('startEventCoreProcess - user consent not given to TRACKING');
            removeSpotFromDictionary(payloadEvent.STARTdata.break_code, payloadEvent.STARTdata.sequence);
        } else { // check if linearAdTracking is true - mandatory to perform tracking
            if (featuresManager.getFeature("linearAdTracking") && featuresManager.getFeature("linearAdTracking") === true) {
                scheduleSpotTracking( payloadEvent.STARTdata.sequence, payloadEvent.STARTdata.break_code);
            }
        }
    }

    function breakTracking(payloadEvent) {
        var sequenceCounter = payloadEvent.STARTdata.sequence;

        function breakTimerCallback() {
            logManager.log("breakTracking - Processing break[" + payloadEvent.LOADdata.break_code + "] - Sequence[" + sequenceCounter + "] started");
            var startPayload = {
                "LOADdata": payloadEvent.LOADdata,
                "STARTdata": {
                    "break_code": payloadEvent.STARTdata.break_code,
                    "sequence": sequenceCounter,
                    "triplet": payloadEvent.STARTdata.triplet,
                    "duration": dictionary.spots[sequenceCounter].duration, //Needed to perform the Spot duration check without a true Start event.
                    "pts": 0
                }
            };
            if (dictionary.spots[sequenceCounter + 1] != null) {
                //Recursive timeout to schedule the tracking of the all spots in the dictionary
                window.setTimeout(breakTimerCallback, dictionary.spots[sequenceCounter].duration + configuration.BLACK_FRAMES_DURATION_AFTER_SPOT);
            }
            startEventProcess(JSON.stringify(startPayload));

            sequenceCounter++;
        }

        //Using PTS in order to trigger the first START. Subsequent ones are chained based on their durations.
        if (featuresManager.getFeature("PTSMethod")) {
            logManager.warning('breakTracking - Waiting first START PTS time in order to start tracking queue.');
            self.ptsHandlerComponent.ptsStartEventTimeCheck(payloadEvent.STARTdata.pts, payloadEvent, breakTimerCallback);
        } else {
            logManager.warning('breakTracking - no PTS or Delay method for this client in the feature file. Queuing starts immediately.');
            breakTimerCallback();
        }
    }

    function scheduleSpotTracking(sequence, break_code) {
        try {
            if (dictionary != null && Object.keys(dictionary).length > 0 && sequence != null && dictionary.id === break_code) {
                /*jshint ignore:start*/
                var timeInterval = dictionary.spots[sequence].duration / 4;
                var quartileCounter = 0;
                injectTrackingPixel(dictionary.spots[sequence].tracking["impression"], "impression", sequence);
                breakTimer = window.setInterval(function () {
                    quartileCounter++;
                    switch (quartileCounter) {
                        case 1:
                            injectTrackingPixel(dictionary.spots[sequence].tracking["firstQuartile"], "firstQuartile", sequence);
                            break;
                        case 2:
                            injectTrackingPixel(dictionary.spots[sequence].tracking["midpoint"], "midpoint", sequence);
                            break;
                        case 3:
                            injectTrackingPixel(dictionary.spots[sequence].tracking["thirdQuartile"], "thirdQuartile", sequence);
                            break;
                        case 4:
                            endProcedure(sequence, break_code);
                            break;
                    }
                }, timeInterval);
                /*jshint ignore:end*/
            } else {
                logManager.warning('scheduleSpotTracking - empty dictionary');
            }
        } catch (e) {
            logManager.error("scheduleSpotTracking: " + e);
            removeSpotFromDictionary(break_code, sequence);
        }
    }

    function injectTrackingPixel(url, name, sequenceNumber) {
        if(trace){
            trace.injectTrackingPixel(url);
        }
        if (configuration.VISIBLE_AD_TRACKING) {// ENABLE FOR DEBUG ONLY
            switch (name) {
                case 'impression':
                case 'complete':
                    trackingPopup(name, url, sequenceNumber);
                    break;
            }
        }
        logManager.log("Sequence[" + sequenceNumber + "] - " + name + " pixel image loaded - " + escapeXml(url));
    }

    function trackingPopup(name, url, sequenceNumber) {
        var container = $(".trackingPopupContainer");
        var top = "5%";
        if (container.length >= 1) {
            top = "50%";
        }
        var $trackPopup = $("<div class='trackingPopupContainer' style='position:absolute; top:" + top + "; left:65px; width: 50%; padding:5px; z-index: 9999; background-color:rgba(255,255,255,0.7); color:#000; border:1px solid #000; word-break: break-all;'><b>Sequence: </b>" + sequenceNumber + "<br /><b>Tracking: </b>" + $.camelCase(name) + "<br /><b>URL: </b> " + escapeXml(url) + "</div>");
        $(".tvium-container").append($trackPopup);

        window.setTimeout(function () {
            $trackPopup.remove();
        }, 3000);
    }

    function endProcedure(sequence, break_code) {
        /*jshint ignore:start*/
        injectTrackingPixel(dictionary.spots[sequence].tracking["complete"], "complete", sequence);
        /*jshint ignore:end*/
        if (breakTimer) {
            window.clearInterval(breakTimer);
        }
        removeSpotFromDictionary(break_code, sequence);
        logManager.log("Adv pixel tracking schedulation ended.");
    }

    function removeSpotFromDictionary(advID, sequence) {
        if (dictionary.spots.hasOwnProperty(sequence)) {
            delete dictionary.spots[sequence];
            if (Object.keys(dictionary.spots).length === 0) {
                //No spots
                resetBreak(advID);
                logManager.log("All spots of the break has been removed!");
            }
        } else {
            logManager.warning('removeSpotFromDictionary - ' + sequence + " not found");
        }
    }

    function resetBreak(advID) {
        clearAdv(advID);
        advHashmap.clearLst();
        dictionary = {};
    }

    function clearAdv(advID) {
        if (advHashmap.isAdvIDExists(advID)) {
            advHashmap.setStatus(advID, advHashmap.lstStatus.STOP);
            advHashmap.deleteAdv(advID);
        } else {
            logManager.warning('clearAdv - event ID not found');
        }
    }

    return {
        configure: configure,
        getConfiguration: getConfiguration,
        onFiredAdv: onFiredAdv,
        callAdServerProcess: callAdServerProcess,
        callVastAdServerProcess: callVastAdServerProcess,
        startProcess: startEventProcess,
        startSCTEProcess: startSCTEProcess
    };
};

var AdvHashmap = function () {
    var lstAdv = {
        status: null,
        dictionary: null
    };
    var advIDLoaded = null;
    var lstStatus = {
        LOADING: "LOADING",
        LOADED: "LOADED",
        STARTING: "STARTING",
        STARTED: "STARTED",
        STOP: "STOP"
    };

    var type = {
        STREAMEVENT: "STREAMEVENT"
    };

    function deleteAdv(advID) {
        delete lstAdv[advID];
        logManager.log('deleteAdv -  Adv Deleted!');
    }

    function clearLst() {
        lstAdv = {};
        advIDLoaded = null;
    }

    function initialize(advID) {
        lstAdv[advID.toString()] = {
            status: null,
            dictionary: null
        };
    }

    function setValue(advID, obj, type) {
        /*jshint ignore:start*/
        if (!isAdvIDExists(advID)) {
            lstAdv[advID] = {};
        }
        lstAdv[advID]["dictionary"] = obj;
        lstAdv[advID]["type"] = type;
        /*jshint ignore:end*/
    }

    function getValue(advID) {
        if (isAdvIDExists(advID)) {
            return lstAdv[advID];
        } else {
            return null;
        }

    }

    function isAdvIDExists(advID) {
        return advID in lstAdv;
    }

    function setStatus(advID, status) {
        if (isAdvIDExists(advID)) {
            /*jshint ignore:start*/
            lstAdv[advID]["status"] = status;
            /*jshint ignore:end*/
            if (status == lstStatus.LOADED) {
                advIDLoaded = advID;
            } else if (status == lstStatus.STOP) {
                advIDLoaded = null;
                logManager.log('Status: ' + status);
            }
        } else {
            logManager.warning('Adv ID not found: ' + advID);
        }
    }

    function lstAdvIsEmpty() {
        return Object.keys(lstAdv).length == 0 || Object.keys(lstAdv).length == 0;
    }

    function isAdvAlreadyLoaded() {
        return advIDLoaded != null;
    }

    function getLoadedAdv() {
        return advIDLoaded;
    }

    return {
        deleteAdv: deleteAdv,
        initialize: initialize,
        setValue: setValue,
        getValue: getValue,
        setStatus: setStatus,
        isAdvIDExists: isAdvIDExists,
        isAdvAlreadyLoaded: isAdvAlreadyLoaded,
        lstStatus: lstStatus,
        type: type,
        clearLst: clearLst,
        lstAdvIsEmpty: lstAdvIsEmpty,
        getLoadedAdv: getLoadedAdv
    };
};

var PtsHandlerComponent = function () {

    this.ptsStartEventTimeCheck = function (pts, payloadEvent, callback) {
        if (mediaSyncManager.getCurrentTime() != null) {
            //pts=mediaSyncManager.getCurrentTime() + 30 * 1000;//test purpose only
            logManager.log("ptsStartEventTimeCheck - currentTime: " + mediaSyncManager.getCurrentTime() + " - PTS check starting in " + (pts - mediaSyncManager.getCurrentTime() - adv.getConfiguration().PTS_CHECK_START_TIME - featuresManager.getFeature("ptsSpotModeSwitchInDurationFineTuning")) + "Ms.");
            setTimeout(function () {
                var ptsCheckPoll = setInterval(function () {
                    var currentTime = mediaSyncManager.getCurrentTime();
                    logManager.log("MediaSynchroniser.currentTime = " + currentTime + " - Event PTS time = " + pts + " - Time difference = " + (Math.abs(pts - currentTime ) - featuresManager.getFeature("ptsSpotModeSwitchInDurationFineTuning")));
                    if (pts - currentTime - featuresManager.getFeature("ptsSpotModeSwitchInDurationFineTuning") + adv.getConfiguration().PTS_CHECK_TOLERANCE < 0) {
                        logManager.warning("ptsStartEventTimeCheck - payload PTS already expired. We can't go back in time Morty!");
                        window.clearInterval(ptsCheckPoll);
                    }
                    if ((Math.abs(pts - currentTime - featuresManager.getFeature("ptsSpotModeSwitchInDurationFineTuning")) <= adv.getConfiguration().PTS_CHECK_TOLERANCE)) {
                        callback(payloadEvent);
                        window.clearInterval(ptsCheckPoll);
                    }
                }, adv.getConfiguration().PTS_CHECK_INTERVAL_TIME + featuresManager.getFeature("PTSCheckIntervalFineTuning"));
            }, pts - mediaSyncManager.getCurrentTime() - adv.getConfiguration().PTS_CHECK_START_TIME - featuresManager.getFeature("ptsSpotModeSwitchInDurationFineTuning"));
        } else {
            logManager.error("ptsStartEventTimeCheck - MediaSynchroniser not available");
        }
    };
};
var AdvRequests =function () {
    var getWizadsDataRetries = 0;
    var getWizadsDataMaxRetries = 1;

    this.getWizadsData = function (url, onSuccess, onFail) {
        var serviceName = "AdvRequests.getWizadsData()";
        var urlManaged = url;
        var ajaxCall;
        logManager.log(serviceName + " CALLED - url: " + url);
        ajaxCall = $.ajax({
            type: "GET",
            contentType: "application/json",
            dataType: "json",
            url: urlManaged,
            timeout: adv.getConfiguration().GET_WIZADS_TIMEOUT,
            success: function (data, textStatus, jqXHR) {
                logManager.log(serviceName + " - Response : OK");
                onSuccess(data);
            },
            error: function (jqXHR, textStatus, errorThrown) {
                logManager.error(serviceName + " - Error " + ": " + JSON.stringify(errorThrown, null, 4));
                if (textStatus === "timeout" && getWizadsDataRetries < getWizadsDataMaxRetries) {
                    getWizadsDataRetries++;
                    self.getWizadsData(url, onSuccess, onFail);
                }
                onFail();
            }
        });

    };

    this.doFreewheelAdCall = function (staticConfiguration, attributes, scte_json, onSuccess, onFail) {
        /*
        https://7e28b.v.fwmrm.net/ad/g/1?nw=516747&mode=live&prof=516747:alpha_JL_XML&caid=jl_videoasset1&csid=alpha_jl_sitesection_iptv_1&resp=vmap1&metr=7&vrdu=150&flag=+emcr+qtcb+slcb+scpv+exvt;_fw_hylda=acid=alpha2%26aiid=JL_TEST_TVIUM_AIRING_BXF%26abid%3Dbreak://14102021_1340&_fw_vcid2=12345&tvium=yes;slid=1234&tpcl=MIDROLL&ptgt=a&maxd=150&mind=150
         */
        if(attributes.segmentation_duration == undefined){
            attributes.segmentation_duration = "";
        }
        var serviceName = "AdvRequests.doFreewheelAdCall()";
        var urlManaged = "https://7e28b.v.fwmrm.net/ad/g/1?nw=516747&mode=live&prof=516747:alpha_JL_XML&caid=jl_videoasset1&csid=alpha_jl_sitesection_iptv_1&resp=vmap1&metr=7&" +
            "vrdu=" + attributes.segmentation_duration +"&flag=+emcr+qtcb+slcb+scpv+exvt;_fw_hylda=" +
            "acid=" + staticConfiguration.acid + "%26" +
            "aiid=" + attributes.segmentation_upid + "%26" +
            "abid%3Dbreak://14102021_1340&_fw_vcid2=12345&tvium=yes;" +
            "slid=" + attributes.segmentation_upid + "&tpcl=MIDROLL&ptgt=a&" +
            "maxd=" + attributes.segmentation_duration +"&mind="+ attributes.segmentation_duration;

        var ajaxCall;
        logManager.log(serviceName + " CALLED - url: " + urlManaged);
        ajaxCall = $.ajax({
            type: "GET",
            dataType: "xml",
            url: urlManaged,
            success: function (data, textStatus, jqXHR) {
                logManager.log(serviceName + " - Response : OK");
                onSuccess(data);
            },
            error: function (jqXHR, textStatus, errorThrown) {
                logManager.error(serviceName + " - Error " + ": " + JSON.stringify(errorThrown, null, 4));
                onFail();
            }
        });
    };
}