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