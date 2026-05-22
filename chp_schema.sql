--
-- PostgreSQL database dump
--

\restrict DzLjFC9xYlhdPFJERMPfbaqgU9quHE5n1RfRQagqok3ddr6InBjiC8EwpGJbg8P

-- Dumped from database version 16.13 (Debian 16.13-1.pgdg12+1)
-- Dumped by pg_dump version 17.9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: chp; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA chp;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approvalstatus; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.approvalstatus (
    id integer NOT NULL,
    status character varying(255)
);


--
-- Name: approvalstatus_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.approvalstatus_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approvalstatus_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.approvalstatus_id_seq OWNED BY chp.approvalstatus.id;


--
-- Name: busfromhr; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.busfromhr (
    id integer NOT NULL,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer
);


--
-- Name: busfromhr_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.busfromhr_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: busfromhr_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.busfromhr_id_seq OWNED BY chp.busfromhr.id;


--
-- Name: bustoday; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.bustoday (
    id integer NOT NULL,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer
);


--
-- Name: bustoday_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.bustoday_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bustoday_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.bustoday_id_seq OWNED BY chp.bustoday.id;


--
-- Name: driver; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.driver (
    id integer NOT NULL,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer
);


--
-- Name: driver_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.driver_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: driver_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.driver_id_seq OWNED BY chp.driver.id;


--
-- Name: driverhistoryfromdriver; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.driverhistoryfromdriver (
    id integer,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer,
    create_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: driverhistoryfromhr; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.driverhistoryfromhr (
    id integer,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer,
    create_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: driverhistoryfromsystem; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.driverhistoryfromsystem (
    id integer,
    driver_user_id character varying(255),
    per_id character varying(20),
    first_name character varying(100),
    last_name character varying(100),
    route character varying(255),
    day character varying(20),
    bound character varying(20),
    "time" character varying(20),
    bus_number integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: lastweek; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.lastweek (
    id integer NOT NULL,
    userid character varying(255),
    route character varying(255),
    monday_inbound character varying(10),
    monday_outbound character varying(10),
    tuesday_inbound character varying(10),
    tuesday_outbound character varying(10),
    wednesday_inbound character varying(10),
    wednesday_outbound character varying(10),
    thursday_inbound character varying(10),
    thursday_outbound character varying(10),
    friday_inbound character varying(10),
    friday_outbound character varying(10),
    saturday_inbound character varying(10),
    saturday_outbound character varying(10),
    sunday_inbound character varying(10),
    sunday_outbound character varying(10),
    department_approval character varying(10)
);


--
-- Name: lastweek_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

ALTER TABLE chp.lastweek ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME chp.lastweek_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: locations; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.locations (
    id integer NOT NULL,
    location_description character varying(255)
);


--
-- Name: locations_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.locations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: locations_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.locations_id_seq OWNED BY chp.locations.id;


--
-- Name: nextweek; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.nextweek (
    id integer NOT NULL,
    userid character varying(255),
    route character varying(255),
    monday_inbound character varying(10),
    monday_outbound character varying(10),
    tuesday_inbound character varying(10),
    tuesday_outbound character varying(10),
    wednesday_inbound character varying(10),
    wednesday_outbound character varying(10),
    thursday_inbound character varying(10),
    thursday_outbound character varying(10),
    friday_inbound character varying(10),
    friday_outbound character varying(10),
    saturday_inbound character varying(10),
    saturday_outbound character varying(10),
    sunday_inbound character varying(10),
    sunday_outbound character varying(10),
    department_approval character varying(10)
);


--
-- Name: nextweek_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.nextweek_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nextweek_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.nextweek_id_seq OWNED BY chp.nextweek.id;


--
-- Name: route; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.route (
    id integer NOT NULL,
    name character varying(255) NOT NULL
);


--
-- Name: route_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.route_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: route_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.route_id_seq OWNED BY chp.route.id;


--
-- Name: seatdriver; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seatdriver (
    id integer NOT NULL,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20)
);


--
-- Name: seatdriver_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.seatdriver_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seatdriver_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.seatdriver_id_seq OWNED BY chp.seatdriver.id;


--
-- Name: seatfromhr; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seatfromhr (
    id integer NOT NULL,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20)
);


--
-- Name: seatfromhr_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.seatfromhr_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seatfromhr_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.seatfromhr_id_seq OWNED BY chp.seatfromhr.id;


--
-- Name: seathistoryfromdriver; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seathistoryfromdriver (
    id integer,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20),
    create_at timestamp without time zone
);


--
-- Name: seathistoryfromhr; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seathistoryfromhr (
    id integer,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20),
    create_at timestamp without time zone
);


--
-- Name: seathistoryfromsystem; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seathistoryfromsystem (
    id integer,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: seattoday; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.seattoday (
    id integer NOT NULL,
    userid character varying(255),
    perid character varying(20),
    first_name character varying(255),
    last_name character varying(255),
    route character varying(255),
    location character varying(255),
    day character varying(20),
    "time" character varying(20),
    busnumber integer,
    seat integer,
    bound character varying(20)
);


--
-- Name: seattoday_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.seattoday_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seattoday_id_seq; Type: SEQUENCE OWNED BY; Schema: chp; Owner: -
--

ALTER SEQUENCE chp.seattoday_id_seq OWNED BY chp.seattoday.id;


--
-- Name: thisweek; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.thisweek (
    id integer NOT NULL,
    userid character varying(255),
    route character varying(255),
    monday_inbound character varying(10),
    monday_outbound character varying(10),
    tuesday_inbound character varying(10),
    tuesday_outbound character varying(10),
    wednesday_inbound character varying(10),
    wednesday_outbound character varying(10),
    thursday_inbound character varying(10),
    thursday_outbound character varying(10),
    friday_inbound character varying(10),
    friday_outbound character varying(10),
    saturday_inbound character varying(10),
    saturday_outbound character varying(10),
    sunday_inbound character varying(10),
    sunday_outbound character varying(10),
    department_approval character varying(10)
);


--
-- Name: thisweek_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

ALTER TABLE chp.thisweek ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME chp.thisweek_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.users_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users; Type: TABLE; Schema: chp; Owner: -
--

CREATE TABLE chp.users (
    id integer DEFAULT nextval('chp.users_seq'::regclass) NOT NULL,
    perid character varying(20),
    userid character varying(255),
    displayname character varying(255),
    first_name character varying(255),
    last_name character varying(255),
    department character varying(255),
    factory character varying(30),
    approvalstatus character varying(30),
    location text
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: chp; Owner: -
--

CREATE SEQUENCE chp.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: approvalstatus id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.approvalstatus ALTER COLUMN id SET DEFAULT nextval('chp.approvalstatus_id_seq'::regclass);


--
-- Name: busfromhr id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.busfromhr ALTER COLUMN id SET DEFAULT nextval('chp.busfromhr_id_seq'::regclass);


--
-- Name: bustoday id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.bustoday ALTER COLUMN id SET DEFAULT nextval('chp.bustoday_id_seq'::regclass);


--
-- Name: driver id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.driver ALTER COLUMN id SET DEFAULT nextval('chp.driver_id_seq'::regclass);


--
-- Name: locations id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.locations ALTER COLUMN id SET DEFAULT nextval('chp.locations_id_seq'::regclass);


--
-- Name: nextweek id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.nextweek ALTER COLUMN id SET DEFAULT nextval('chp.nextweek_id_seq'::regclass);


--
-- Name: route id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.route ALTER COLUMN id SET DEFAULT nextval('chp.route_id_seq'::regclass);


--
-- Name: seatdriver id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seatdriver ALTER COLUMN id SET DEFAULT nextval('chp.seatdriver_id_seq'::regclass);


--
-- Name: seatfromhr id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seatfromhr ALTER COLUMN id SET DEFAULT nextval('chp.seatfromhr_id_seq'::regclass);


--
-- Name: seattoday id; Type: DEFAULT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seattoday ALTER COLUMN id SET DEFAULT nextval('chp.seattoday_id_seq'::regclass);


--
-- Name: approvalstatus approvalstatus_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.approvalstatus
    ADD CONSTRAINT approvalstatus_pkey PRIMARY KEY (id);


--
-- Name: approvalstatus approvalstatus_status_key; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.approvalstatus
    ADD CONSTRAINT approvalstatus_status_key UNIQUE (status);


--
-- Name: busfromhr busfromhr_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.busfromhr
    ADD CONSTRAINT busfromhr_pkey PRIMARY KEY (id);


--
-- Name: bustoday bustoday_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.bustoday
    ADD CONSTRAINT bustoday_pkey PRIMARY KEY (id);


--
-- Name: driver driver_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.driver
    ADD CONSTRAINT driver_pkey PRIMARY KEY (id);


--
-- Name: locations locations_location_description_key; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.locations
    ADD CONSTRAINT locations_location_description_key UNIQUE (location_description);


--
-- Name: locations locations_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.locations
    ADD CONSTRAINT locations_pkey PRIMARY KEY (id);


--
-- Name: nextweek nextweek_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.nextweek
    ADD CONSTRAINT nextweek_pkey PRIMARY KEY (id);


--
-- Name: route route_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.route
    ADD CONSTRAINT route_pkey PRIMARY KEY (id);


--
-- Name: seatdriver seatdriver_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seatdriver
    ADD CONSTRAINT seatdriver_pkey PRIMARY KEY (id);


--
-- Name: seatfromhr seatfromhr_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seatfromhr
    ADD CONSTRAINT seatfromhr_pkey PRIMARY KEY (id);


--
-- Name: seattoday seattoday_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.seattoday
    ADD CONSTRAINT seattoday_pkey PRIMARY KEY (id);


--
-- Name: thisweek thisweek_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.thisweek
    ADD CONSTRAINT thisweek_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: chp; Owner: -
--

ALTER TABLE ONLY chp.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- PostgreSQL database dump complete
--

\unrestrict DzLjFC9xYlhdPFJERMPfbaqgU9quHE5n1RfRQagqok3ddr6InBjiC8EwpGJbg8P


